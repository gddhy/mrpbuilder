#include "mrc_base.h"

// --- 宏定义 ---
#define MR_SUCCESS 0
#define MR_FAILED -1
#define TRUE 1
#define FALSE 0

#define MEM_TYPE_MAIN   0xAA  // 主内存标记
#define MEM_TYPE_EX1012 0xBB  // 扩展内存 1012 (Cache)
#define MEM_TYPE_EX1014 0xCC  // 扩展内存 1014 (Screen Buffer)

#define DETECT_STEP     (1024 * 16) // 每次递增检测 16KB
#define DETECT_START    (1024 * 4)  // 从 4KB 开始检测

#define MRC_EXRAM_FILE "cache/exr.cac"

// --- 结构体定义 ---

// 内存块头部，用于 mrc_free 时识别内存来源
typedef struct {
    int32 type;     // 内存类型 (Main, 1012, 1014)
    int32 size;     // 申请的大小
    uint32 magic;   // 校验位，防止野指针
} MemHeader;

// --- 全局变量 ---
static int32 g_exRam1012_Total = 0; // 检测到的 1012 总大小
static int32 g_exRam1014_Total = 0; // 检测到的 1014 总大小
static int32 g_exRam_Used = 0;      // 扩展内存已用统计(仅统计通过mrc_exRamMalloc分配的)
static int32 g_isDetected = FALSE;  // 是否已检测

// --- 外部依赖声明 (假设 mrc_base.h 中未完全包含或为了兼容) ---
// extern int32 mrc_platExCP(int32 code, uint8* input, int32 input_len, uint8** output, int32* output_len, void *cb);
// extern int32 mrc_platCP(int32 code, int32 param);

// extern uint32 mrc_getMemoryRemain(void);
// extern int32 mrc_getSysMem(void);

// 文件操作接口
// extern int32 mrc_open(const char* filename, uint32 mode);
// extern int32 mrc_close(int32 f);
// extern int32 mrc_write(int32 f, void *p, uint32 l);
// extern int32 mrc_read(int32 f, void *p, uint32 l);
// extern int32 mrc_remove(const char* filename);

// --- 内部底层封装 (Code 1012-1015) ---

// 申请 1012 (Cache)
static void* _alloc_1012(int32 size) {
    uint8* output = NULL;
    int32 output_len = 0;
    int32 ret = mrc_platExCP(1012, NULL, size, &output, &output_len, NULL);
    if (ret == MR_SUCCESS) return (void*)output;
    return NULL;
}

// 释放 1013 (Cache)
static void _free_1013(void* ptr) {
    if (ptr) mrc_platExCP(1013, (uint8*)ptr, 0, NULL, NULL, NULL);
}

// 申请 1014 (Buffer)
static void* _alloc_1014(int32 size) {
    uint8* output = NULL;
    int32 output_len = 0;
    int32 ret = mrc_platExCP(1014, NULL, size, &output, &output_len, NULL);
    if (ret == MR_SUCCESS) return (void*)output;
    return NULL;
}

// 释放 1015 (Buffer)
static void _free_1015(void* ptr) {
    if (ptr) mrc_platExCP(1015, (uint8*)ptr, 0, NULL, NULL, NULL);
}

// --- 核心检测逻辑 ---

/**
 * 通用内存检测函数
 * @param alloc_func 申请函数指针
 * @param free_func  释放函数指针
 * @param cb         进度回调
 * @param progress_base 进度条起始百分比
 * @param progress_scale 进度条占比 (例如50表示占总进度的50%)
 * @return 检测到的最大可用连续内存大小
 */
typedef void* (*AllocFunc)(int32);
typedef void (*FreeFunc)(void*);

static int32 _detect_memory_loop(AllocFunc alloc_func, FreeFunc free_func, 
                                 mrc_exRamDetect_progress_cb_t cb, 
                                 int progress_base, int progress_scale) {
    int32 current_size = DETECT_START;
    int32 max_success_size = 0;
    void* ptr = NULL;
    int ratio = 0;

    // 假设最大检测到 4MB，用于计算进度条
    const int32 ESTIMATED_MAX = 4 * 1024 * 1024; 

    while (1) {
        // 尝试申请
        ptr = alloc_func(current_size);
        
        // 更新进度条
        if (cb) {
            // 简单计算一下进度，防止溢出
            int step_ratio = (int)((long long)current_size * progress_scale / ESTIMATED_MAX);
            if (step_ratio > progress_scale) step_ratio = progress_scale;
            cb(progress_base + step_ratio);
        }

        if (ptr != NULL) {
            // 申请成功，记录大小并释放
            max_success_size = current_size;
            free_func(ptr);
            
            // 增加申请大小
            current_size += DETECT_STEP;
        } else {
            // 申请失败，达到极限
            break;
        }
        
        // 安全保护：防止死循环（虽然实际上内存有限）
        if (current_size > 32 * 1024 * 1024) break; 
    }
    
    return max_success_size;
}

/*
 *  调用这个API开始内存检测
 *  分别检测 1012 和 1014
 */
void mrc_exRamDetect(mrc_exRamDetect_progress_cb_t cb) {
    // 1. 检测 1012 (0% - 50%)
    g_exRam1012_Total = _detect_memory_loop(_alloc_1012, _free_1013, cb, 0, 50);
    
    // 2. 检测 1014 (50% - 100%)
    g_exRam1014_Total = _detect_memory_loop(_alloc_1014, _free_1015, cb, 50, 50);

    g_isDetected = TRUE;
    
    if (cb) cb(100);
}

/*
 *  判断是否需要检测
 */
int32 mrc_exRamNeedDetect(int32 numBytes) {
    // 尝试申请一次指定大小
    void* p = _alloc_1012(numBytes);
    if (p) {
        _free_1013(p);
        // 如果能申请到，且之前已有记录，可能不需要全量检测
        // 但根据需求描述，如果申请成功返回FALSE(不需要检测)?
        // 实际上，为了准确性，通常建议未检测过就检测
        if (g_isDetected) return FALSE;
        return FALSE; 
    }
    
    // 申请失败，肯定需要检测或者初始化
    return TRUE; 
}

int mrc_exRamDetected(void) {
    return g_isDetected ? MR_SUCCESS : MR_FAILED;
}

// --- 初始化与释放 ---

int32 mrc_exRamInitEx(int num) {
    // 如果传入了固定大小，则覆盖检测值（通常不建议，除非从文件读取了配置）
    if (num > 0) {
        g_exRam1012_Total = num;
        // 1014 未知
    }
    g_exRam_Used = 0;
    // 这里不再置 g_isDetected，因为 Init 不等于 Detect 过程
    return MR_SUCCESS;
}

int32 mrc_exRamInit(void) {
    return mrc_exRamInitEx(0);
}

int32 mrc_exRamRelease(void) {
    g_exRam1012_Total = 0;
    g_exRam1014_Total = 0;
    g_exRam_Used = 0;
    g_isDetected = FALSE;
    return MR_SUCCESS;
}

// --- 内存申请/释放 (带Header) ---

/*
 * 仅申请扩展内存 (暴露给上层的接口，对应 1012)
 * 纯粹的 wrapper，不带 header
 */
void* mrc_exRamMallocOnly(int size) {
    void* ptr = _alloc_1012(size);
    if (ptr) {
        // 这里无法精确统计 Used，因为没有 header 记录 size
        // 但如果是内部调用，通常会加上 header
    }
    return ptr;
}

/*
 * 仅释放扩展内存 (暴露给上层的接口，对应 1013)
 */
void mrc_exRamFreeOnly(void *address) {
    _free_1013(address);
}


/*
 * 智能内存申请
 * 优先级：扩展内存(1012) -> 主内存
 * 注意：通常 1014 (Screen Buffer) 不适合做通用内存分配(mrc_exRamMalloc)，
 * 因为它可能在切屏时失效，所以这里只使用 1012。
 */
void* mrc_exRamMalloc(int size) {
    if (size <= 0) return NULL;

    int total_len = size + sizeof(MemHeader);
    void* ptr = NULL;
    int alloc_type = 0;

    // 1. 尝试从 1012 申请
    // 只有在检测到有容量时才尝试，避免频繁调用底层开销
    if (g_exRam1012_Total > 0) {
        ptr = _alloc_1012(total_len);
        if (ptr) {
            alloc_type = MEM_TYPE_EX1012;
            g_exRam_Used += total_len;
        }
    }

    // 2. 如果失败，尝试主内存
    if (ptr == NULL) {
        ptr = mrc_malloc(total_len);
        if (ptr) {
            alloc_type = MEM_TYPE_MAIN;
        }
    }

    // 3. 写入头部信息
    if (ptr) {
        MemHeader* header = (MemHeader*)ptr;
        header->type = alloc_type;
        header->size = size; // 记录用户申请的大小
        header->magic = 0x4D524348; // "MRCH"
        return (uint8*)ptr + sizeof(MemHeader);
    }

    return NULL;
}

/*
 * 智能释放
 */
void mrc_exRamFree(void *address) {
    if (address == NULL) return;

    // 回退获取头部
    MemHeader* header = (MemHeader*)((uint8*)address - sizeof(MemHeader));
    
    // 简单的魔数校验
    if (header->magic != 0x4D524348) {
        // 异常：不是通过 mrc_exRamMalloc 申请的内存，或者内存被破坏
        // 尝试直接释放主内存(作为保底)，或者忽略
        // mrc_free(address); // 危险操作
        return;
    }

    void* real_ptr = (void*)header;
    int total_len = header->size + sizeof(MemHeader);

    switch (header->type) {
        case MEM_TYPE_EX1012:
            _free_1013(real_ptr);
            g_exRam_Used -= total_len;
            break;
        case MEM_TYPE_MAIN:
            mrc_free(real_ptr);
            break;
        case MEM_TYPE_EX1014:
            // 如果未来扩展支持 1014 分配
            _free_1015(real_ptr);
            break;
        default:
            break;
    }
}

// --- 文件持久化 ---

int32 mrc_exRamStore(void) {
    int32 f;
    int32 ret;
    
    mrc_remove(MRC_EXRAM_FILE);
    
    f = mrc_open(MRC_EXRAM_FILE, MR_FILE_WRONLY | MR_FILE_CREATE);
    if (f == 0) return MR_FAILED;

    // 保存检测状态和大小
    // 格式：[DetectedFlag(4)] [Total1012(4)] [Total1014(4)]
    mrc_write(f, &g_isDetected, 4);
    mrc_write(f, &g_exRam1012_Total, 4);
    ret = mrc_write(f, &g_exRam1014_Total, 4);

    mrc_close(f);
    return (ret == 4) ? MR_SUCCESS : MR_FAILED;
}

int32 mrc_exRamLoad(void) {
    int32 f;
    
    f = mrc_open(MRC_EXRAM_FILE, MR_FILE_RDONLY);
    if (f == 0) return MR_FAILED;

    mrc_read(f, &g_isDetected, 4);
    mrc_read(f, &g_exRam1012_Total, 4);
    mrc_read(f, &g_exRam1014_Total, 4);

    mrc_close(f);
    
    if (g_isDetected) {
        return MR_SUCCESS;
    }
    return MR_FAILED;
}

// --- 状态获取 ---

int mrc_getMemStatus(int * mainUsed, int * mainLeft, 
                     int * ssbUsed, int * ssbLeft,  
                     int * sbasmUsed, int * sbasmLeft) {
    
    // 主内存信息
    int32 totalMain = mrc_getSysMem();
    int32 remainMain = mrc_getMemoryRemain();
    
    if (mainUsed) *mainUsed = totalMain - remainMain;
    if (mainLeft) *mainLeft = remainMain;

    // ssb (对应 1014 Screen Buffer)
    if (ssbUsed) *ssbUsed = -1; // Screen Buffer 通常是一次性分配，难以统计"已用"
    if (ssbLeft) *ssbLeft = g_exRam1014_Total; // 返回检测到的总量

    // sbasm (对应 1012 ExRam)
    if (sbasmUsed) *sbasmUsed = g_exRam_Used;
    if (sbasmLeft) *sbasmLeft = (g_exRam1012_Total > g_exRam_Used) ? 
                                (g_exRam1012_Total - g_exRam_Used) : 0;

    return totalMain; // 返回主内存峰值/总量
}