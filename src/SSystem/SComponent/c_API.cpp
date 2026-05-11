/**
 * c_API.cpp
 *
 */

#include "SSystem/SComponent/c_API.h"

extern void mDoGph_BlankingON();
extern void mDoGph_BlankingOFF();
extern int mDoGph_BeforeOfDraw();
extern int mDoGph_AfterOfDraw();
extern int mDoGph_Painter();
extern int mDoGph_Create();

cAPI_Interface g_cAPI_Interface = {
    mDoGph_Create,
    mDoGph_BeforeOfDraw,
    mDoGph_AfterOfDraw,
    mDoGph_Painter,
    mDoGph_BlankingON,
    mDoGph_BlankingOFF,
};
