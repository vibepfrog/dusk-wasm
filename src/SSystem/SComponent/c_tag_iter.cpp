/**
 * c_tag_iter.cpp
 *
 */

#include "SSystem/SComponent/c_tag_iter.h"
#include "SSystem/SComponent/c_tag.h"

int cTgIt_MethodCall(node_class* pTag, void* pFilter) {
    create_tag_class* tag = (create_tag_class*)pTag;
    method_filter* filter = (method_filter*)pFilter;
    return filter->mpMethodFunc((node_class*)tag->mpTagData, filter->mpUserData);
}

void* cTgIt_JudgeFilter(node_class* pTag, void* pFilter) {
    create_tag_class* tag = (create_tag_class*)pTag;
    judge_filter* filter = (judge_filter*)pFilter;
    return filter->mpJudgeFunc((node_class*)tag->mpTagData, filter->mpUserData);
}
