#include "emoji.h"
#include "mrc_graphics.h"
#include "xl_bmp.h"

/*
 * emoji绘制库
 * 实现emoji图标的加载和绘制
 *
 * 功能：
 * 1. 从assets目录加载emoji图片
 * 2. 如果图片不存在则绘制灰色矩形占位
 *
 * 风的影子
 */

/* emoji缓存结构 */
typedef struct {
    char *emoji_name;      /* emoji名称 */
    int size;              /* emoji尺寸 */
    BITMAP_565 *bitmap;    /* 图片数据 */
} EMOJI_CACHE;

/* 最大缓存数量 */
#define MAX_EMOJI_CACHE 32

/* emoji缓存数组 */
static EMOJI_CACHE g_emoji_cache[MAX_EMOJI_CACHE];
static int g_emoji_cache_count = 0;

/*
 * 从缓存中查找emoji
 * 返回: 找到返回bitmap指针，否则返回NULL
 */
static BITMAP_565* find_emoji_cache(const char *emoji, int size) {
    int i;

    for (i = 0; i < g_emoji_cache_count; i++) {
        if (g_emoji_cache[i].size == size &&
            mrc_strcmp(g_emoji_cache[i].emoji_name, emoji) == 0) {
            return g_emoji_cache[i].bitmap;
        }
    }

    return NULL;
}

/*
 * 添加emoji到缓存
 * 返回: MR_SUCCESS 成功, MR_FAILED 失败
 */
static int32 add_emoji_cache(const char *emoji, int size, BITMAP_565 *bitmap) {
    int name_len;

    if (g_emoji_cache_count >= MAX_EMOJI_CACHE) {
        return MR_FAILED;
    }

    /* 分配内存保存emoji名称 */
    name_len = mrc_strlen(emoji);
    g_emoji_cache[g_emoji_cache_count].emoji_name = mrc_malloc(name_len + 1);
    if (g_emoji_cache[g_emoji_cache_count].emoji_name == NULL) {
        return MR_FAILED;
    }

    mrc_strcpy(g_emoji_cache[g_emoji_cache_count].emoji_name, emoji);
    g_emoji_cache[g_emoji_cache_count].size = size;
    g_emoji_cache[g_emoji_cache_count].bitmap = bitmap;
    g_emoji_cache_count++;

    return MR_SUCCESS;
}

/*
 * 构造emoji文件名
 * 格式: emoji_24x24.png
 *
 * emoji: emoji字符
 * size: 尺寸
 * filename: 输出文件名缓冲区
 * max_len: 缓冲区最大长度
 */
static void build_emoji_filename(const char *emoji, int size, char *filename, int max_len) {
    mrc_sprintf(filename, "%s_%dx%d.png", emoji, size, size);
}

/*
 * 绘制emoji, size表示emoji图标的宽高
 *
 * emoji: emoji字符，例如 "🛸"
 * x, y: 绘制位置
 * size: emoji图标的宽高
 *
 * 返回: MR_SUCCESS 成功, MR_FAILED 失败
 */
int32 emoji_draw(char *emoji, int x, int y, int size) {
    char filename[128];
    BITMAP_565 *bitmap;

    /* 参数检查 */
    if (emoji == NULL || size <= 0) {
        return MR_FAILED;
    }

    /* 先从缓存中查找 */
    bitmap = find_emoji_cache(emoji, size);

    /* 如果缓存中没有，尝试加载 */
    if (bitmap == NULL) {
        /* 构造文件名 */
        build_emoji_filename(emoji, size, filename, sizeof(filename));

        /* 尝试从assets目录加载 */
        bitmap = readBitmapFromAssets(filename);

        if (bitmap != NULL) {
            /* 加载成功，添加到缓存 */
            add_emoji_cache(emoji, size, bitmap);
        }
    }

    /* 如果成功加载，绘制bitmap */
    if (bitmap != NULL) {
        drawBitmap(bitmap, x, y);
        return MR_SUCCESS;
    }

    /* 如果没有找到图片，绘制灰色矩形占位 */
    gl_drawRect(x, y, size, size, 0xFF808080);  /* 灰色 ARGB */

    return MR_SUCCESS;
}

/*
 * 释放emoji资源
 *
 * 返回: MR_SUCCESS 成功
 */
int32 emoji_free(void) {
    int i;

    /* 释放所有缓存的bitmap */
    for (i = 0; i < g_emoji_cache_count; i++) {
        if (g_emoji_cache[i].bitmap != NULL) {
            bitmapFree(g_emoji_cache[i].bitmap);
            g_emoji_cache[i].bitmap = NULL;
        }

        if (g_emoji_cache[i].emoji_name != NULL) {
            mrc_free(g_emoji_cache[i].emoji_name);
            g_emoji_cache[i].emoji_name = NULL;
        }
    }

    /* 重置缓存计数 */
    g_emoji_cache_count = 0;

    return MR_SUCCESS;
}
