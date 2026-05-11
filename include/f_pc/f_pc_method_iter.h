
#ifndef F_PC_METHOD_ITER_H_
#define F_PC_METHOD_ITER_H_

#include <types.h>
#include "SSystem/SComponent/c_node_iter.h"

typedef struct node_list_class node_list_class;

// Widened to match cNdIt_MethodFunc exactly so wasm CFI accepts the indirect call
// chain cLsIt_Method -> cNdIt_Method -> i_methods without any function-pointer cast.
typedef cNdIt_MethodFunc fpcMtdIt_MethodFunc;

int fpcMtdIt_Method(node_list_class* pList, fpcMtdIt_MethodFunc pMethod);

#endif
