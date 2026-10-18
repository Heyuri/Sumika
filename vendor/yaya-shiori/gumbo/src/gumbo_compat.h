// Compatibility shims for compilers that do not provide POSIX/C99 features
// used by Gumbo (Visual C++ 6.0 and later MSVC).  Include this instead of
// <strings.h> from C sources.

#ifndef GUMBO_COMPAT_H_
#define GUMBO_COMPAT_H_

#ifdef _MSC_VER

#include <string.h>
#include <stdio.h>

#ifndef strcasecmp
#define strcasecmp _stricmp
#endif
#ifndef strncasecmp
#define strncasecmp _strnicmp
#endif

// MSVC before 2015 does not have a conforming vsnprintf.
#if _MSC_VER < 1900 && !defined(vsnprintf)
#define vsnprintf _vsnprintf
#endif

// "inline" is not a keyword in C mode of MSVC before 2015.
#if _MSC_VER < 1900 && !defined(__cplusplus) && !defined(inline)
#define inline __inline
#endif

#else

#include <strings.h>

#endif  // _MSC_VER

#endif  // GUMBO_COMPAT_H_
