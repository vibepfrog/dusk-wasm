#ifndef F_PC_PAUSE_
#define F_PC_PAUSE_

#include <types.h>

int fpcPause_IsEnable(void* pProc, u8 expected);
int fpcPause_Enable(void* pProc, void* /*pauseMask as void* */);
int fpcPause_Disable(void* pProc, void* /*pauseMask as void* */);
void fpcPause_Init(void* pProc);

#endif
