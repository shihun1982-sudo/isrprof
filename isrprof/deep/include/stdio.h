#ifndef _ISRPROF_STDIO_H
#define _ISRPROF_STDIO_H
#include <stddef.h>
#include <stdarg.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct _isrprof_FILE FILE;
int printf(const char *, ...); int sprintf(char *, const char *, ...); int snprintf(char *, size_t, const char *, ...);
int vsnprintf(char *, size_t, const char *, va_list); int puts(const char *); int putchar(int);
#ifdef __cplusplus
}
#endif
#endif
