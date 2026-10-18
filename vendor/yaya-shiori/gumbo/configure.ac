#                                               -*- Autoconf -*-
# Process this file with autoconf to produce a configure script.

AC_PREREQ([2.72])
AC_INIT([gumbo], [0.14.1], [me@txgk.in])
AC_SUBST(gumbo_version_info, [4:1:0])
AC_CONFIG_MACRO_DIR([m4])
AC_CONFIG_SRCDIR([src/parser.c])
#AC_CONFIG_HEADERS([config.h])
AC_CONFIG_FILES([Makefile gumbo.pc])

# Checks for programs.
AC_PROG_CC
AC_PROG_CXX

# Checks for libraries.

# Checks for header files.
AC_CHECK_HEADERS([stddef.h stdlib.h string.h strings.h])

# Checks for typedefs, structures, and compiler characteristics.
AC_C_INLINE
AC_TYPE_SIZE_T

# Checks for library functions.
AC_CHECK_LIB([gtest_main],
             [main],
             AM_CONDITIONAL(HAVE_SHARED_LIBGTEST, [true]),
             AM_CONDITIONAL(HAVE_SHARED_LIBGTEST, [false]))

AC_ARG_ENABLE([examples],
              AS_HELP_STRING([--disable-examples], [Disable examples]))
AM_CONDITIONAL([HAVE_EXAMPLES], [test "x$enable_examples" != "xno"])

# Init Automake & libtool
AM_INIT_AUTOMAKE([foreign subdir-objects])
m4_ifdef([AM_SILENT_RULES], [AM_SILENT_RULES([yes])])
LT_INIT

AC_OUTPUT

AC_MSG_WARN([])
AC_MSG_WARN([============= WARNING ===============])
AC_MSG_WARN([Autotools build method is deprecated!])
AC_MSG_WARN([Please use Meson build system instead])
AC_MSG_WARN([=====================================])
AC_MSG_WARN([])
