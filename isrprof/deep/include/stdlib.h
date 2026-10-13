#ifndef _ISRPROF_STDLIB_H
#define _ISRPROF_STDLIB_H
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
void *malloc(size_t); void *calloc(size_t, size_t); void *realloc(void *, size_t); void free(void *);
int abs(int); long labs(long); int atoi(const char *); long strtol(const char *, char **, int); unsigned long strtoul(const char *, char **, int);
void abort(void); void exit(int); int rand(void); void srand(unsigned);
#ifdef __cplusplus
}
#endif
#endif
