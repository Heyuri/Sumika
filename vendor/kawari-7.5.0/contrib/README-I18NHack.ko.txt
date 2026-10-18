
                         KAWARI SHIORI의 국제화 해킹

							산오리 정주원
							(sanori@sanori.net)
개론
====
이것은 Meister로 알려진 Nakaue T 님께서 제작한 KAWARI SHIORI (이하 카와리)의
patch입니다. 이 patch를 적용하시면 KSC-5601 한글로 작성한 카와리 사전을
글자의 깨짐 없이 사용하실 수 있습니다.
사실은 한글 뿐 아니라 중국어 등의 북동아시아어 및 독일어와 같은 유럽어로
작성된 사전도 사용할 수 있도록 만들었습니다.

동기
====
(자세한 내용은 readme-i18n.en.txt를 참조해 주십시오)

방법
====
(자세한 내용은 readme-i18n.en.txt를 참조해 주십시오)

사용법
======   
1. 한국어 (혹은 비 일본어) 고스트의 shiori.dll을 이 패치에 포함된 것으로
   바꾼다.

2. kawari.ini에 로케일(locale) 이름을 써 넣는다. 예를들어 한국어라면

	locale: ko_ko.eucKR

   또는 줄여서

   	locale: ko

   라고 써 넣는다.

   일반적으로 로케일 이름은 다음과 같은 형태를 따른다.

	language[_territory][.codeset][@modifier]

   language : ISO 639 2글자 언어 코드
   territory: ISO 3166 2글자 국가
   codeset  : ISO-8859-1 혹은 UTF-8과 같은 부호화된 문자집합 이름

   각 코드에 대해서는 다음 문서를 찾아볼 수 있다.
	http://www.ics.uci.edu/pub/ietf/http/related/iso639.txt
	http://www.ics.uci.edu/pub/ietf/http/related/iso3166.txt

   현재 지원되는 축약 로케일:
	en(영어), fr(프랑스어), de(독일어), es(스페인어), ru(러시아어),
	ja(일본어), ko(한국어), zh(중국어)

   현재 지원되는 부호화된 문자집합 이름:
	iso-8859-1, iso-8859-2, iso-8859-5, SJIS(shift_jis),
	EUC-JP, EUC-KR, EUC-CN, EUC-TW, BIG5, KOI8,
	UTF8 (KIS에서 'expr'함수를 쓰지 말것, 현재 오작동)

컴파일 방법
===========
이 patch는 소스화일 없이 patch 화일만을 가지고 있습니다. 따라서
직접 compile을 하려면 http://meister-d-i.hoops.ne.jp/ 에서
kawari-2001-0825-1900을 받아오신 후 patch 명령으로 소스를 고치셔야
합니다.

컴파일은 MinGW에서 밖에 해보지 못했습니다. 방법은 

	make -r -f mingw_kawari.mak

를 src 디렉토리에서 수행하면 됩니다.

* 주: 최근의 노력으로 인하여, 이 패치는 KAWARI-731-kpcg "응원단" 판
      (http://users.goo.ne.jp/shobu/ 에서 찾을 수 있음)을 기본으로 합니다.
      또한, M$ Visual C++ 6.0 에서 테스트되었습니다. 다른 컴파일러를
      사용하려면, 해당 컴파일러의 MAKEFILEF 설정에서 I18N_HACK 을 자동으로
      설정하도록 고치시기 바랍니다.

환경
====
제작환경: MinGW 1.0.1 on M$ Windows 98 SE  (http://www.mingw.org)
	  (그렇습니다. 상용 compiler도 아니고 cygwin1.dll도 필요없습니다. -- 산오리)
          M$ Visual C++ 6.0 on M$ Windows 98 SE
          (뭐, 벌써 돈내고 샀으니 써야죠 :P -- whoami)
실험환경: M$ Windows 98 SE Korean

배경
====
카와리는 '무언가'라는 응용프로그램의 부분을 구성합니다. '무언가'에 대해서는

	http://futaba.mikage.to/ (일본어) 
	http://yser.cool4u.co.kr/nanika/ (한국어)
	http://homepage1.nifty.com/znc/ (영어)

등의 사이트를 참조하시기 바랍니다.

또한 최근 버전의 카와리는 http://meister-d-i.hoops.ne.jp/ 에서 찾을 수 있습니다.
* 주: "응원단" 판은 http://users.goo.ne.jp/shobu/ 에서 찾을 수 있습니다.


역사
====
2002.01.11  "응원단" 판 KAWARI-731-kpcg 에 적용.
            whoami (uotakie@kebi.com)
2001.10.09  KIS의 'expr'에서 생기는 문제 해결. 그러나 여전히 UTF-8은 안된다.
            whoami (uotalkie@kebi.com)
2001.09.09  한국어 뿐 아니라 다른 언어도 처리하게끔 국제화
            Visual C++에서밖에 compile 안되게 된 부분 제거 (산오리)
2001.09.03  EUC-KR로 부호화된 한국어를 처리할 수 있도록 kawari를 patch.
            whoami (uotalkie@kebi.com)


