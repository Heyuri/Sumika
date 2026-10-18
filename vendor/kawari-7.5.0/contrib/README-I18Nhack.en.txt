
               INTERNATIONALIZATION HACK OF KAWARI SHIORI

						Joo-won Jung a.k.a Sanori
						(sanori@sanori.net)

What is this?
=============
This is the I18N patch of KAWARI SHIORI by Nakaue T. (Meister)
This patch enables using of Korean, Chinese and European characters
with KAWARI SHIORI. This is based on KAWARI-2001-0825-1900.
* Note: During the last effort, this is now based on KAWARI-731-kpcg
        "Ouendan" edition.

Motivation
==========
Since Kawari SHIORI is designed and developed for Japanese Windows,
it assumes that the sentences and words are encoded in Shift_JIS
which is multi-byte character set. Shift_JIS is not conformable to
ISO-2022 character set classification. So the multibyte area of
Shift_JIS is very different from other coded character sets,
especially EUC ones.

When I tried to create GHOST for Korean environment, I found that some
Korean characters displayed wrong and some dictionaries ignored comma
separator. So, I examined the kawari source and found that there is
skip routine for SJIS kanji, iskanji1st(char).

In case of Korean character 'KIYEOK-YE', it is encoded 0xB0E8 in KS C
5601 (Korean part of EUC-KR) encoding. In Shift_JIS, 0xB0 is in half
width kana area (1byte), and 0xE8 is in the 1st character of 2byte
kanji area. As a result, Kawari decodes following comma character as
a part of kanji character. So the dictionary corrupts.

You may say you can change iskanji1st() to return always 0, or remove
the routine. But, in that case Shift_JIS does not work correctly
because the second byte range covers 0x40~0xfc (except 0x7f) which
includes 'at sign'(@) and 'backslash' (\) character.

Moreover, I have noticed that some EUC-JP characters are 3 bytes long.
So, I decided to make kawari understand document encoding at first.


Approach
========
If I wanted to make kawari *really* international, I should have
 1. Changed all the string related routines to Unicode one.
 2. provided or gotten the code conversion table from OS using POSIX
    setlocale(), mbtowc(), wctomb().
 3. fixed some other routines related time, date, monetary and messages. 

But I have had enough time, the support of Windows98 for I18N is not
so good, and POSIX I18N calls are not thread safe and, more than other
things, 'redo', the base program of Nanika is not internationalized.
('redo' always asks 'Charset: Shift_JIS' even if it runs on Korean
Windows.) So, I just hacked the source. (Even thought it is also
thread unsafe. -_-;)


Usage
=====
1. Replace shiori.dll for non-Japanese GHOST.
2. Add locale directive in kawari.ini, e.g. for Korean Language

	locale: ko_KR.eucKR

   or, in short

	locale: ko

A locale name is typically of the form

	language[_territory][.codeset][@modifier]

where  language is an ISO 639 language code, territory is
an ISO 3166 country code, and codeset is a character set or
encoding identifier like ISO-8859-1 or UTF-8. You may get
these documents from
http://www.ics.uci.edu/pub/ietf/http/related/iso639.txt
http://www.ics.uci.edu/pub/ietf/http/related/iso3166.txt

Currently supported short-form locales are:
	en(English), fr(French), de(German), es(Spanish), ru(Russian),
	ja(Japanese), ko(Korean), zh(Chinese)

Currently supported character encodings are:
	iso-8859-1, iso-8859-2, iso-8859-5, SJIS(shift_jis),
	EUC-JP, EUC-KR, EUC-CN, EUC-TW, BIG5, KOI8,
	UTF8 (do not use 'expr' in KIS)


Compiling
=========
This patch contains patch file only. You should get kawari-2001-0825-1900
from http://meister-d-i.hoops.ne.jp/ and patch using 'patch' command
if you want to compile this. 

I have tested only in MinGW. The way to compile is
	make -r -f mingw_kawari.mak

* Note: During the last effort, this is now based on KAWARI-731-kpcg
        "Ouendan" edition (found on http://users.goo.ne.jp/shobu/).
        Also, it is tested in M$ Visual C++ 6.0. For other compilers,
        please modify their MAKEFILEs to define I18N_HACK automatically.


Environment
===========
Development: MinGW 1.0.1 on M$ Windows 98 SE  (http://www.mingw.org)
	     (Yes, No commercial compiler and no cygwin*.dll -- Sanori)
             M$ Visual C++ 6.0 on M$ Windows 98 SE
             (Well, I already paid it so I have to use it :P -- whoami)
Test: M$ Windows 98 SE Korean


BACKGROUND
==========
KAWARI SHIORI is the part of the NANIKA application. You may get more
information at http://futaba.mikage.to/ (Japanese) and 
http://homepage1.nifty.com/znc/ (English).

You may get latest KAWARI shiori from http://meister-d-i.hoops.ne.jp/ .
* Note: You may also get the "Ouendan" editions from http://users.goo.ne.jp/shobu/.

History
=======
2002.01.11  Applied to "Ouendan" edition KAWARI-731-kpcg by "whoami"
            (uotakie@kebi.com)
2001.10.09  'expr' bug fix (But, there is still bugs when UTF-8 used)
            by "whoami" (uotalkie@kebi.com).
2001.09.09  Internationalization. Remove the code which is compiled
            only in VC++ by Sanori.
2001.09.03  Korean patch which enables to use EUC-KR encoded Korean
	    developed by "whoami" (uotalkie@kebi.com).
