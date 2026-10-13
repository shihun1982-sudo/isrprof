#ifndef _ISRPROF_STDDEF_H
#define _ISRPROF_STDDEF_H
typedef __SIZE_TYPE__ size_t; typedef __PTRDIFF_TYPE__ ptrdiff_t;
#ifndef __cplusplus
typedef __WCHAR_TYPE__ wchar_t;
#endif
#ifndef NULL
#ifdef __cplusplus
#define NULL 0
#else
#define NULL ((void*)0)
#endif
#endif
#define offsetof(t, m) __builtin_offsetof(t, m)
#endif
