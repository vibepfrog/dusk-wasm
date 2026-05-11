/**
 * f_pc_manager.cpp
 * Framework - Process Manager
 */

#include "f_pc/f_pc_manager.h"
#include <cstdint>
#include "SSystem/SComponent/c_API_graphic.h"
#include "SSystem/SComponent/c_lib.h"
#include "Z2AudioLib/Z2SoundMgr.h"
#include "d/d_com_inf_game.h"
#include "d/d_error_msg.h"
#include "d/d_lib.h"
#include "d/d_particle.h"
#include "f_ap/f_ap_game.h"
#include "f_pc/f_pc_creator.h"
#include "f_pc/f_pc_deletor.h"
#include "f_pc/f_pc_draw.h"
#include "f_pc/f_pc_fstcreate_req.h"
#include "f_pc/f_pc_line.h"
#include "f_pc/f_pc_pause.h"
#include "f_pc/f_pc_priority.h"
#include "m_Do/m_Do_controller_pad.h"

#include "tracy/Tracy.hpp"

int fpcM_Draw(void* i_proc, void* /*unused*/) {
    fpcDw_Execute((base_process_class*)i_proc);
    return 0;
}

int fpcM_DrawIterater(fpcM_DrawIteraterFunc i_drawIterFunc) {
    return fpcLyIt_OnlyHere(fpcLy_RootLayer(), i_drawIterFunc, NULL);
}

int fpcM_Execute(void* i_proc, void* /*unused*/) {
    return fpcEx_Execute((base_process_class*)i_proc);
}

int fpcM_Delete(void* i_proc) {
    return fpcDt_Delete((base_process_class*)i_proc);
}

BOOL fpcM_IsCreating(fpc_ProcID i_id) {
    return fpcCt_IsCreatingByID(i_id);
}

void fpcM_Management(fpcM_ManagementFunc i_preExecuteFn, fpcM_ManagementFunc i_postExecuteFn) {
    ZoneScoped;
#ifdef __EMSCRIPTEN__
    static int s_fpcm_iter = 0;
    bool trace = (s_fpcm_iter++ < 2);
    if (trace) OSReport(">>> fpcM_Management iter=%d step=1 MtxInit\n", s_fpcm_iter - 1);
#endif
    MtxInit();
    if (!fapGm_HIO_c::isCaptureScreen()) {
        dComIfGd_peekZdata();
    }
    fapGm_HIO_c::executeCaptureScreen();
#ifdef __EMSCRIPTEN__
    if (trace) OSReport(">>> fpcM_Management step=2 dShutdownErrorMsg::execute\n");
#endif

    bool shutdownRet = dShutdownErrorMsg_c::execute();
    if (!shutdownRet) {
        static bool l_dvdError = false;
#ifdef __EMSCRIPTEN__
        if (trace) OSReport(">>> fpcM_Management step=3 dDvdErrorMsg::execute\n");
#endif

        bool dvdErrRet = dDvdErrorMsg_c::execute();
        if (!dvdErrRet) {
            if (l_dvdError) {
                dLib_time_c::startTime();
                Z2GetSoundMgr()->pauseAllGameSound(false);
                l_dvdError = false;
            }

#ifdef TARGET_PC
            // FRAME INTERP NOTE: Called in m_Do_main when interp is enabled
            if (!dusk::frame_interp::is_enabled())
#endif
            {
#ifdef __EMSCRIPTEN__
                if (trace) OSReport(">>> fpcM_Management step=4 cAPIGph_Painter\n");
#endif
                cAPIGph_Painter();
            }

#ifdef __EMSCRIPTEN__
            if (trace) OSReport(">>> fpcM_Management step=5 fpcDt_Handler\n");
#endif
            if (!dPa_control_c::isStatus(1)) {
                fpcDt_Handler();
            } else {
                dPa_control_c::offStatus(1);
            }

#ifdef __EMSCRIPTEN__
            if (trace) OSReport(">>> fpcM_Management step=6 fpcPi_Handler\n");
#endif
            if (!fpcPi_Handler()) {
                JUT_ASSERT(353, FALSE);
            }

#ifdef __EMSCRIPTEN__
            if (trace) OSReport(">>> fpcM_Management step=7 fpcCt_Handler\n");
#endif
            if (!fpcCt_Handler()) {
                JUT_ASSERT(357, FALSE);
            }

#ifdef __EMSCRIPTEN__
            if (trace) OSReport(">>> fpcM_Management step=8 i_preExecuteFn\n");
#endif
            if (i_preExecuteFn != NULL) {
                i_preExecuteFn();
            }

#ifdef __EMSCRIPTEN__
            if (trace) OSReport(">>> fpcM_Management step=9 fpcEx_Handler\n");
#endif
            if (!fapGm_HIO_c::isCaptureScreen()) {
                fpcEx_Handler(fpcM_Execute);
            }

#ifdef __EMSCRIPTEN__
            if (trace) OSReport(">>> fpcM_Management step=10 fpcDw_Handler\n");
#endif
            if (!fapGm_HIO_c::isCaptureScreen() || fapGm_HIO_c::getCaptureScreenDivH() != 1) {
                fpcDw_Handler(fpcM_DrawIterater, fpcM_Draw);
            }

#ifdef __EMSCRIPTEN__
            if (trace) OSReport(">>> fpcM_Management step=11 i_postExecuteFn\n");
#endif
            if (i_postExecuteFn != NULL) {
                i_postExecuteFn();
            }

#ifdef __EMSCRIPTEN__
            if (trace) OSReport(">>> fpcM_Management step=12 dComIfGp_drawSimpleModel\n");
#endif
            dComIfGp_drawSimpleModel();
#ifdef __EMSCRIPTEN__
            if (trace) OSReport(">>> fpcM_Management step=13 done\n");
#endif
        } else if (!l_dvdError) {
            dLib_time_c::stopTime();
            Z2GetSoundMgr()->pauseAllGameSound(true);
#if PLATFORM_GCN
#define FPCM_MANAGEMENT_GAMEPAD_COUNT 1
#elif PLATFORM_SHIELD && !DEBUG
#define FPCM_MANAGEMENT_GAMEPAD_COUNT 0
#else
#define FPCM_MANAGEMENT_GAMEPAD_COUNT 4
#endif
            for (u32 i = 0; i < FPCM_MANAGEMENT_GAMEPAD_COUNT; i++) {
                mDoCPd_c::stopMotorWaveHard(i);
            }
            l_dvdError = true;
        }
    }
}

void fpcM_Init() {
    static layer_class rootlayer;
    static node_list_class queue[10];

    fpcLy_Create(&rootlayer, NULL, queue, 10);
    fpcLn_Create();
}

base_process_class* fpcM_FastCreate(s16 i_procname, FastCreateReqFunc i_createReqFunc,
                                    void* i_createData, void* i_append) {
    return fpcFCtRq_Request(fpcLy_CurrentLayer(), i_procname, (fstCreateFunc)i_createReqFunc,
                            i_createData, i_append);
}

int fpcM_IsPause(void* i_proc, u8 i_flag) {
    return fpcPause_IsEnable((base_process_class*)i_proc, i_flag & 0xFF);
}

void fpcM_PauseEnable(void* i_proc, u8 i_flag) {
    fpcPause_Enable((process_node_class*)i_proc, (void*)(uintptr_t)(i_flag & 0xFF));
}

void fpcM_PauseDisable(void* i_proc, u8 i_flag) {
    fpcPause_Disable((process_node_class*)i_proc, (void*)(uintptr_t)(i_flag & 0xFF));
}

void* fpcM_JudgeInLayer(fpc_ProcID i_layerID, fpcCtIt_JudgeFunc i_judgeFunc, void* i_data) {
    layer_class* layer = fpcLy_Layer(i_layerID);
    if (layer != NULL) {
        void* ret = fpcCtIt_JudgeInLayer(i_layerID, i_judgeFunc, i_data);
        if (ret == NULL) {
            return fpcLyIt_Judge(layer, i_judgeFunc, i_data);
        }
        return ret;
    }

    return NULL;
}
