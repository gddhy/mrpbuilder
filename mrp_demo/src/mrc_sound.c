#include <mrc_base.h>
#include <mrc_exb.h>
#include "mrc_sound.h"

// 音频命令基数定义 (对应文档 6.2.54)
#define CMD_AUDIO_INIT      2010
#define CMD_AUDIO_LOAD_FILE 2020
#define CMD_AUDIO_LOAD_BUF  2030
#define CMD_AUDIO_PLAY      2040
#define CMD_AUDIO_PAUSE     2050
#define CMD_AUDIO_RESUME    2060
#define CMD_AUDIO_STOP      2070
#define CMD_AUDIO_CLOSE     2080
#define CMD_AUDIO_STATE     2090
#define CMD_AUDIO_SET_POS   2100 // 设置时间 (文档说是秒，部分平台修订为ms，依具体平台而定)
#define CMD_AUDIO_SET_OFF   2110 // 设置偏移
#define CMD_AUDIO_GET_TOTAL 2120
#define CMD_AUDIO_GET_CUR_S 2130 // 秒
#define CMD_AUDIO_GET_PROG  2140
#define CMD_AUDIO_GET_CUR_MS 2150 // 毫秒

// 生成最终Code的宏: 201X -> 2010 + type
#define AUDIO_CODE(base, type) ((base) + (type))





// 对应文档 203X 加载缓冲数据的结构
typedef struct
{
    char* buf;      // 缓冲数据指针
    int32 buf_len;  // 缓冲数据长度
} T_AUDIO_LOAD_BUF;

// 对应文档 204X 播放请求的结构
typedef struct
{
    ACI_PLAY_CB cb; // 回调函数
    int32 loop;     // 0:单次, 1:循环, 2:PCM循环
    int32 block;    // 1:阻塞, 0:非阻塞
} T_AUDIO_PLAY_REQ;


/*
    每次播放前需调用
    Code: 201X
*/
int32 mrc_playSoundExInit(int32 type)
{
    // 文档 201X: 设备初始化
    return mrc_platExCP(AUDIO_CODE(CMD_AUDIO_INIT, type), NULL, 0, NULL, NULL, NULL);
}

/*
    加载音频文件 (Buffer形式)
    Code: 203X
*/
int32 mrc_playSoundExLoad(int32 type, const void * data, int32 buf_len)
{
    // 文档 203X: 加载缓冲数据
    T_AUDIO_LOAD_BUF req;
    req.buf = (char*)data;
    req.buf_len = buf_len;

    return mrc_platExCP(AUDIO_CODE(CMD_AUDIO_LOAD_BUF, type), 
                        (uint8*)&req, sizeof(T_AUDIO_LOAD_BUF), 
                        NULL, NULL, NULL);
}

/*
    加载音频文件 (文件名形式)
    Code: 202X
*/
int32 mrc_playSoundExLoadFile(int32 type, char* filename)
{
    int32 len = 0;
    // 计算字符串长度(简单实现，或者依赖string.h)
    char *p = filename;
    while(*p++) len++;
    len++; // 包含结束符

    // 文档 202X: 加载一个文件
    return mrc_platExCP(AUDIO_CODE(CMD_AUDIO_LOAD_FILE, type), 
                        (uint8*)filename, len, 
                        NULL, NULL, NULL);
}

/*
    播放音频文件
    Code: 204X
*/
int32 mrc_playSoundEx(int32 type, int32 block, int32 loop, ACI_PLAY_CB cb)
{
    // 文档 204X: 从当前的位置开始播放
    T_AUDIO_PLAY_REQ req;
    req.cb = cb;
    req.loop = loop;
    req.block = block;

    return mrc_platExCP(AUDIO_CODE(CMD_AUDIO_PLAY, type), 
                        (uint8*)&req, sizeof(T_AUDIO_PLAY_REQ), 
                        NULL, NULL, NULL);
}

/*
    暂停播放音频文件
    Code: 205X
*/
int32 mrc_pauseSoundEx(int32 type)
{
    return mrc_platExCP(AUDIO_CODE(CMD_AUDIO_PAUSE, type), NULL, 0, NULL, NULL, NULL);
}

/*
    继续播放音频文件
    Code: 206X
*/
int32 mrc_resumeSoundEx(int32 type)
{
    return mrc_platExCP(AUDIO_CODE(CMD_AUDIO_RESUME, type), NULL, 0, NULL, NULL, NULL);
}

/*
    停止播放音频文件
    Code: 207X
*/
int32 mrc_stopSoundEx(int32 type)
{
    return mrc_platExCP(AUDIO_CODE(CMD_AUDIO_STOP, type), NULL, 0, NULL, NULL, NULL);
}

/*
    关闭设备
    Code: 208X
*/
int32 mrc_closeSoundEx(int32 type)
{
    return mrc_platExCP(AUDIO_CODE(CMD_AUDIO_CLOSE, type), NULL, 0, NULL, NULL, NULL);
}

/*
    音量调节
    Code: 1302 (plat, not platEx)
*/
int32 mrc_setVolume(int32 volume)
{
    // 文档 5.3.31 code = 1302
    return mrc_platCP(1302, volume);
}

/*
    获取音乐的总时间秒S
    Code: 212X
*/
int32 mrc_getSoundTotalTime(int32 type, uint8** p)
{
    int32 output_len = 0;
    // 文档 212X: 获取整首歌的播放时间 (output struct { int32 pos; })
    return mrc_platExCP(AUDIO_CODE(CMD_AUDIO_GET_TOTAL, type), 
                        NULL, 0, 
                        p, &output_len, NULL);
}

/*
    获取当前已经播放的时间秒S
    Code: 213X
*/
int32 mrc_getSoundCurTime(int32 type, uint8** p)
{
    int32 output_len = 0;
    // 文档 213X: 获取当前的播放进度时间(s)
    return mrc_platExCP(AUDIO_CODE(CMD_AUDIO_GET_CUR_S, type), 
                        NULL, 0, 
                        p, &output_len, NULL);
}

/*
    获取当前已经播放的时间毫秒ms
    Code: 215X
*/
int32 mrc_getSoundCurTimeMs(int32 type, uint8** p)
{
    int32 output_len = 0;
    // 文档 215x: 获取当前的播放进度时间(ms)
    return mrc_platExCP(AUDIO_CODE(CMD_AUDIO_GET_CUR_MS, type), 
                        NULL, 0, 
                        p, &output_len, NULL);
}

/*
    设置播放位置，相对文件或者缓冲的起始位置的偏移量
    Code: 211X
*/
int32 mrc_setPlayPos(int32 type, T_DSM_AUDIO_POS pos)
{
    // 文档 211X: 设置播放位置 (偏移量)
    // 输入为 struct { int32 pos; }，正好匹配 T_DSM_AUDIO_POS
    return mrc_platExCP(AUDIO_CODE(CMD_AUDIO_SET_OFF, type), 
                        (uint8*)&pos, sizeof(T_DSM_AUDIO_POS), 
                        NULL, NULL, NULL);
}

/*
    设置播放时间
    Code: 210X
    注意：文档 210x 说明单位为 s，但旧版本或部分实现可能混淆，这里严格透传参数。
*/
int32 mrc_setPlayTime(int32 type, T_DSM_AUDIO_POS pos)
{
    // 文档 210X: 设置播放位置 (时间)
    return mrc_platExCP(AUDIO_CODE(CMD_AUDIO_SET_POS, type), 
                        (uint8*)&pos, sizeof(T_DSM_AUDIO_POS), 
                        NULL, NULL, NULL);
}

/*
    获取当前设备的状态
    Code: 209X
*/
int32 mrc_getDeviceState(int32 type)
{
    // 文档 209X: 返回值直接是 MR_PLAT_VALUE_BASE + 设备状态值
    // mrc_platExCP 的返回值即为底层 mr_platEx 的返回值
    return mrc_platExCP(AUDIO_CODE(CMD_AUDIO_STATE, type), NULL, 0, NULL, NULL, NULL);
}