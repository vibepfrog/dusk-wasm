#include "JSystem/JSystem.h" // IWYU pragma: keep

#include "JSystem/JAudio2/JASTaskThread.h"
#include "JSystem/JAudio2/JASCalc.h"
#include "JSystem/JAudio2/JASCriticalSection.h"
#include "JSystem/JKernel/JKRSolidHeap.h"

JASTaskThread::JASTaskThread(int priority, int msgCount, u32 stackSize) :
    JKRThread(JASDram, stackSize, msgCount, priority)
{
    field_0x84 = false;
    OSInitThreadQueue(&threadQueue_);
}

JASTaskThread::~JASTaskThread() {
    OSMessage msg;
    BOOL received;
    while (true) {
        msg = waitMessage(&received);
        if (!received) {
            return;
        }
        JASKernel::getCommandHeap()->free(msg);
    }
}

void* JASTaskThread::allocCallStack(JASThreadCallback callback, const void* msg, u32 msgSize) {
    ThreadMemPool* heap;
    u32 size = msgSize + offsetof(JASThreadCallStack, msg);
    JASThreadCallStack *callStack = (JASThreadCallStack*) JASKernel::getCommandHeap()->alloc(size);
    if (callStack == NULL) {
        return NULL;
    }

    callStack->msgType_ = 1;
#if TARGET_ANDROID
    JASCalc::_bcopy(msg, callStack->msg.buffer, msgSize);
#else
    JASCalc::bcopy(msg, callStack->msg.buffer, msgSize);
#endif
    callStack->callback_ = callback;
    return callStack;
}

void* JASTaskThread::allocCallStack(JASThreadCallback callback, void* msg) {
    JASThreadCallStack *callStack;
    callStack = (JASThreadCallStack*)JASKernel::getCommandHeap()->alloc(offsetof(JASThreadCallStack, msg) + sizeof(void*));
    if (callStack == NULL) {
        return NULL;
    }

    callStack->msgType_ = 0;
    callStack->msg.bufferPtr = msg;
    callStack->callback_ = callback;
    return callStack;
}

int JASTaskThread::sendCmdMsg(JASThreadCallback callback, const void* msg, u32 msgSize) {
#ifdef __EMSCRIPTEN__
    // Single-threaded wasm: the JAS task thread (JASDvd, JASAramStream, etc.)
    // is silently no-op'd by the emscripten branch of OSResumeThread in
    // src/dusk/OSThread.cpp. JASTaskThread::run() is a pump that would dequeue
    // messages and invoke the callback — running the callback inline here is
    // the same shape of fix we applied to mDoDvdThd_param_c::addition. The
    // callback contract accepts the message pointer; we pass it through since
    // the caller's buffer is still alive on the stack at the invocation point.
    callback(const_cast<void*>(msg));
    return 1;
#else
    void* callstack;

    callstack = allocCallStack(callback, msg, msgSize);
    if (callstack == NULL) {
        return 0;
    }

    BOOL iVar2 = sendMessage(callstack);
    if (!iVar2) {
        JASKernel::getCommandHeap()->free(callstack);
    }
    return iVar2;
#endif
}

int JASTaskThread::sendCmdMsg(JASThreadCallback callback, void* msg) {
#ifdef __EMSCRIPTEN__
    // See the const-buffer overload above for context — same inline dispatch.
    callback(msg);
    return 1;
#else
    void* callstack;

    callstack = allocCallStack(callback, msg);
    if (callstack == NULL) {
        return 0;
    }

    BOOL iVar2 = sendMessage(callstack);
    if (!iVar2) {
        JASKernel::getCommandHeap()->free(callstack);
    }
    return iVar2;
#endif
}

void* JASTaskThread::run() {
    JASThreadCallStack* callstack;
    OSInitFastCast();
    do {
#ifdef TARGET_PC
        BOOL received = FALSE;
        callstack = static_cast<JASThreadCallStack*>(waitMessageBlock(&received));
        if (!received) {
            break;
        }
#else
        callstack = static_cast<JASThreadCallStack*>(waitMessageBlock());
#endif
        if (field_0x84) {
            OSSleepThread(&threadQueue_);
        }

        if (callstack->msgType_) {
            callstack->callback_(callstack->msg.buffer);
        } else {
            callstack->callback_(callstack->msg.bufferPtr);
        }

        JASKernel::getCommandHeap()->free(callstack);
    } while (true);
#ifdef TARGET_PC
    return NULL;
#endif
}

void JASTaskThread::pause(bool param_0) {
    JASCriticalSection aJStack_14;
    if (param_0) {
        field_0x84 = 1;
    } else {
        if (field_0x84) {
            OSWakeupThread(&threadQueue_);
        }
        field_0x84 = 0;
    }
}
