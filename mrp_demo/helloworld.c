/**
 * MRP Helloworld 示例程序
 * 一个简单的MRP应用程序，显示"Hello World!"文本和基本UI
 * 遵循功能机开发规范
 */

#include <mrc_base.h>      /* 基础API、按键定义、事件定义 */
#include "uc3_font.h"     /* 字体绘制 */
#include "mpc.h"          /* 基础功能转换支持 */
#include "mrc_graphics.h" /* 图形绘制API */
#include "xl_debug.h"     /* 调试支持 */

/* 前向声明 */
void drawHelloWorld(void);
void drawSoftKeyHints(char* leftText, char* rightText);

/* 全局变量 */
int32 timer_cd;            /* 定时器句柄 */

/**
 * 定时器回调函数
 * 使用定时器模拟游戏循环（30fps）
 */
void timer_run(int32 id) {
    /* 清屏并绘制内容 */
    drawHelloWorld();
    
    /* 必须刷新屏幕 */
    mrc_refreshScreen(0, 0, SCRW, SCRH);
}

/**
 * 绘制Hello World界面
 */
void drawHelloWorld(void) {
    char text[100];
    int textWidth;
    
    /* 清屏为黑色背景 */
    mrc_clearScreen(0, 0, 0);
    
    /* 绘制标题 */
    uc3_drawText("Helloworld2", 10, 10, 255, 255, 255, 0);
    
    /* 绘制分隔线 */
    gl_drawLine(10, 40, SCRW - 10, 40, 0xFFFFFF00);
    
    /* 绘制主文本 */
    uc3_drawText("Hello World!", 50, 80, 0, 255, 0, 0);
    
    /* 绘制多行说明文本 */
    uc3_drawTextInRect("这是一个简单的MRP示例程序\n"
                       "演示了基本的MRP开发规范\n"
                       "包括：定时器、绘图、字体、按键处理", 
                       10, -8, 10, 120, SCRW - 20, 80, 
                       200, 200, 255, 0);
    
    /* 绘制屏幕信息 */
    mrc_sprintf(text, "屏幕尺寸: %dx%d", SCRW, SCRH);
    uc3_drawText(text, 10, 220, 180, 180, 180, 0);
    
    /* 绘制随机数示例 */
    int randomNum = mrc_rand() % 100;
    mrc_sprintf(text, "随机数: %d", randomNum);
    uc3_drawText(text, 10, 240, 180, 220, 180, 0);
    
    /* 绘制软键提示 */
    drawSoftKeyHints("选择", "退出");
}

/**
 * 绘制软键提示
 * @param leftText  左软键提示文字
 * @param rightText 右软键提示文字
 */
void drawSoftKeyHints(char* leftText, char* rightText) {
    int leftX, rightX, y;
    
    /* 软键提示区域距离底部25像素 */
    y = SCRH - 25;
    
    /* 左软键提示（屏幕左下） */
    if (leftText != NULL) {
        leftX = 10;
        uc3_drawText(leftText, leftX, y, 255, 255, 255, 0);
    }
    
    /* 右软键提示（屏幕右下） */
    if (rightText != NULL) {
        int textWidth = uc3_getWidth(rightText, 0);
        rightX = SCRW - textWidth - 10;
        uc3_drawText(rightText, rightX, y, 255, 255, 255, 0);
    }
}

/**
 * 程序初始化函数
 * 在程序启动时调用一次
 */
int32 mrc_init(void) {
    /* 打印调试信息 */
    mrc_printf("=== MRP Helloworld 启动 ===");
    
    /* 初始化基础功能转换 */
    mrc_printf("初始化基础功能...");
    mpc_init();
    
    /* 初始化字体 */
    mrc_printf("初始化字体...");
    uc3_init();
    
    /* 初始化随机数种子 */
    mrc_printf("初始化随机数...");
    mrc_sand(mrc_getUptime());
    
    /* 绘制初始界面 */
    mrc_printf("绘制初始界面...");
    drawHelloWorld();
    mrc_refreshScreen(0, 0, SCRW, SCRH);
    
    /* 创建定时器实现30fps游戏循环 */
    mrc_printf("创建定时器(30fps)...");
    timer_cd = mrc_timerCreate();
    mrc_timerStart(timer_cd, 33, 0, timer_run, 1);  /* 33ms = 30fps */
    
    mrc_printf("=== 初始化完成 ===");
    return 0;
}

/**
 * 事件处理函数
 * 处理按键和触摸事件
 */
int32 mrc_event(int32 code, int32 param0, int32 param1) {
    /* 按键释放事件 */
    if (code == KY_UP) {
        switch (param0) {
            case _SLEFT:    /* 左软键 */
                mrc_printf("左软键: 选择");
                /* 这里可以添加选择功能的代码 */
                break;
                
            case _SRIGHT:   /* 右软键 */
                mrc_printf("右软键: 退出程序");
                mrc_exit();
                break;
                
            case _SELECT:   /* 确认键 */
                mrc_printf("确认键: 重新生成随机数");
                drawHelloWorld();
                mrc_refreshScreen(0, 0, SCRW, SCRH);
                break;
                
            case _UP:       /* 上方向键 */
                mrc_printf("上方向键");
                break;
                
            case _DOWN:     /* 下方向键 */
                mrc_printf("下方向键");
                break;
        }
    }
    /* 触摸释放事件 */
    else if (code == MS_UP) {
        mrc_printf("触摸事件: x=%d, y=%d", param0, param1);
        
        /* 绘制触摸点 */
        mrc_clearScreen(0, 0, 0);
        drawHelloWorld();
        
        /* 在触摸点绘制一个圆圈 */
        gl_drawHollowCir(param0, param1, 20, 0xFFFF0000);
        
        mrc_refreshScreen(0, 0, SCRW, SCRH);
    }
    
    return 0;
}

/**
 * 程序暂停函数
 * 当程序被切换到后台时调用
 */
int32 mrc_pause(void) {
    mrc_printf("程序暂停");
    return 0;
}

/**
 * 程序恢复函数
 * 当程序从后台恢复时调用
 */
int32 mrc_resume(void) {
    mrc_printf("程序恢复");
    return 0;
}

/**
 * 程序退出函数
 * 在程序退出前调用，用于清理资源
 */
int32 mrc_exitApp(void) {
    mrc_printf("=== MRP Helloworld 退出 ===");
    
    /* 停止定时器 */
    mrc_timerStop(timer_cd);
    mrc_timerDelete(timer_cd);
    
    /* 释放字体资源 */
    uc3_free();
    
    mrc_printf("资源已释放");
    return 0;
}

/**
 * 插件事件接收函数（必须存在）
 */
int32 mrc_extRecvAppEvent(int32 app, int32 code, int32 param0, int32 param1) {
    mrc_printf("插件事件: app=%d, code=%d", app, code);
    return 0;
}

/**
 * 扩展插件事件接收函数（必须存在）
 */
int32 mrc_extRecvAppEventEx(int32 code, int32 p0, int32 p1, int32 p2, int32 p3,
                            int32 p4, int32 p5) {
    mrc_printf("扩展插件事件: code=%d", code);
    return 0;
}
