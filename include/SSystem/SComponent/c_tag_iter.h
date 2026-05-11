#ifndef C_TAG_ITER_H
#define C_TAG_ITER_H

#include "SSystem/SComponent/c_node_iter.h"

typedef struct create_tag_class create_tag_class;

typedef struct method_filter {
    cNdIt_MethodFunc mpMethodFunc;
    void* mpUserData;
} method_filter;

typedef struct judge_filter {
    cNdIt_JudgeFunc mpJudgeFunc;
    void* mpUserData;
} judge_filter;

int cTgIt_MethodCall(node_class* pTag, void* pMethodFilter);
void* cTgIt_JudgeFilter(node_class* pTag, void* pJudgeFilter);

#endif /* C_TAG_ITER_H */
