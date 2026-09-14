#include <mrc_base.h> // For NULL

// 假设的基础类型定义，如果项目中已有定义可忽略
typedef signed int      int32;
typedef unsigned char   uint8;

// 外部提供的平台调用接口
extern int32 mrc_platExCP(int32 code, uint8* input, int32 input_len, uint8** output, int32* output_len, void *cb);
extern int32 mrc_platCP(int32 code, int32 param);

// --- 结构体定义 (来源于提问) ---

typedef struct
{
    char *src;
    int32 len;
    int32 src_type; // MRAPP_SRC_TYPE
} MRAPP_IMAGE_ORIGIN_T, *PMRAPP_IMAGE_ORIGIN_T;

typedef struct 
{
    char *src;      // 文件名(GB格式)或是数据流的buf地址
    int32 src_len;  // src所指的buf的大小
    int32 src_type; // MRAPP_SRC_TYPE
    int32 ox;       // rect x
    int32 oy;       // rect y
    int32 w;        // width
    int32 h;        // height
} T_DRAW_DIRECT_REQ, *PT_DRAW_DIRECT_REQ;

typedef struct
{
    char *src;      // 文件名(GB格式)或是数据流的buf地址
    int32 len;      // src所指的buf的大小
    int32 width;    // 用户图片显示的区域的宽度
    int32 height;   // 用于图片显示的区域的高度
    int32 src_type; // MRAPP_SRC_TYPE
    char *dest;     // 解码后的图片数据存放的buf (rgb565)
} MRAPP_IMAGE_DECODE_T, *PMRAPP_IMAGE_DECODE_T;

typedef struct 
{
    int32 p1;       // gif动画句柄
} T_DSM_COMMON_RSP, *PT_DSM_COMMON_RSP;


// --- 函数实现 ---

/**
 * @brief 获取图片信息 (Code 3001)
 * 
 * @param image 输入图片源信息结构体
 * @param output 输出参数，平台返回包含宽高信息的结构体指针
 *               返回结构: typedef struct { int32 width; int32 height; };
 * @return int32 MR_SUCCESS / MR_FAILED / MR_IGNORE
 */
int32 mrc_getImageInfo(PMRAPP_IMAGE_ORIGIN_T image, uint8** output)
{
    int32 output_len = 0;
    // 文档 6.2.55 Code 3001
    return mrc_platExCP(3001, (uint8*)image, sizeof(MRAPP_IMAGE_ORIGIN_T), output, &output_len, NULL);
}

/**
 * @brief 直接绘制图片(如JPEG)到FrameBuffer (Code 3010)
 *        直接调用平台接口将图片绘制到指定的矩形内
 * 
 * @param input 绘制请求参数
 * @return int32 MR_SUCCESS / MR_FAILED
 */
int32 mrc_drawJpegToFrameBuffer(PT_DRAW_DIRECT_REQ input)
{
    uint8* output = NULL;
    int32 output_len = 0;
    // 文档 6.2.55 Code 3010
    return mrc_platExCP(3010, (uint8*)input, sizeof(T_DRAW_DIRECT_REQ), &output, &output_len, NULL);
}

/**
 * @brief 绘制GIF并开始动画 (Code 3011)
 *        显示gif动画的接口（直接绘制到frame buffer上），每一帧动画的显示也都是mtk来控制
 * 
 * @param input 绘制请求参数
 * @param output 输出参数，返回包含GIF句柄的结构体(T_DSM_COMMON_RSP)
 * @return int32 MR_SUCCESS / MR_FAILED
 */
int32 mrc_drawGifToFrameBuffer(PT_DRAW_DIRECT_REQ input, uint8** output)
{
    int32 output_len = 0;
    // 文档 6.2.55 Code 3011
    return mrc_platExCP(3011, (uint8*)input, sizeof(T_DRAW_DIRECT_REQ), output, &output_len, NULL);
}

/**
 * @brief 停止GIF动画 (Code 3012)
 *        动画停止需要调用mr_plat(3012,句柄)
 * 
 * @param input 包含GIF句柄的结构体 (T_DSM_COMMON_RSP)
 * @return int32 MR_SUCCESS / MR_FAILED
 */
int32 mrc_stopGif(PT_DSM_COMMON_RSP input)
{
    if (input == NULL) {
        return -1; // MR_FAILED
    }
    // 文档 6.2.55 Code 3012: 调用mr_plat接口，Param的值就是mr_platEx的code返回的动画句柄
    return mrc_platCP(3012, input->p1);
}

/**
 * @brief 解码GIF到Buffer (Code 3004)
 *        解码一张GIF图片，将解完的数据放到dest所指的buf中
 * 
 * @param input 解码请求参数
 * @param output 输出参数，返回 MRAPP_GIF_HEADER 结构体指针
 * @return int32 MR_SUCCESS / MR_FAILED / MR_IGNORE
 */
int32 mrc_decodeGifToBuffer(PMRAPP_IMAGE_DECODE_T input, uint8** output)
{
    int32 output_len = 0;
    // 文档 6.2.55 Code 3004
    return mrc_platExCP(3004, (uint8*)input, sizeof(MRAPP_IMAGE_DECODE_T), output, &output_len, NULL);
}

/**
 * @brief 释放GIF解码资源 (Code 3005)
 *        应用通知移植释放先前gif解码（3004）用到的资源
 * 
 * @return int32 MR_SUCCESS / MR_FAILED / MR_IGNORE
 */
int32 mrc_releaseDecGifRes(void)
{
    uint8* output = NULL;
    int32 output_len = 0;
    // 文档 6.2.55 Code 3005
    return mrc_platExCP(3005, NULL, 0, &output, &output_len, NULL);
}