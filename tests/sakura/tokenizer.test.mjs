// SakuraScript tokenizer: SS §3.9 vectors and edge cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, parseBracket, parseString } from '../../src/sakura/tokenizer.js';

const BS = '\\';
// write scripts with '¥' standing for a backslash so the vectors read like the spec
const S = s => s.replace(/¥/g, BS);
// compact view: text -> 'text', tag -> {name,args,form}
const view = toks => toks.map(t => t.type === 'text' ? t.text
  : t.type === 'env' ? { env: t.name, ...(t.arg != null ? { arg: t.arg } : {}) }
    : { [t.type === 'unknown' ? 'unknown' : 'tag']: t.name, args: t.args, form: t.form });

function covers(src, toks) {
  let at = 0;
  for (const t of toks) {
    assert.equal(t.pos, at, `token starts at ${at}`);
    assert.ok(t.end > t.pos, 'non-empty token');
    if (t.raw != null) assert.equal(t.raw, src.slice(t.pos, t.end));
    at = t.end;
  }
  assert.equal(at, src.length, 'tokens cover the script');
}

const vectors = [
  ['¥s10', [{ tag: 's', args: ['1'], form: 'digit' }, '0']],
  ['¥w10', [{ tag: 'w', args: ['1'], form: 'digit' }, '0']],
  ['¥w[1000]', [{ tag: 'w', args: ['1000'], form: 'bracket' }]],
  ['¥_b["menu¥choice5.png",inline]', [{ tag: '_b', args: [S('menu¥choice5.png'), 'inline'], form: 'bracket' }]],
  ['¥_b[card¥field.png,23,12]', [{ tag: '_b', args: [S('card¥field.png'), '23', '12'], form: 'bracket' }]],
  ['¥![raise,OnTest,"100,2"]', [{ tag: '!', args: ['raise', 'OnTest', '100,2'], form: 'bracket' }]],
  ['¥![call,ghost,"the ""MobileMaster"""]', [{ tag: '!', args: ['call', 'ghost', 'the "MobileMaster"'], form: 'bracket' }]],
  ['¥q[a¥]b,id]', [{ tag: 'q', args: ['a]b', 'id'], form: 'bracket' }]],
  ['¥8¥n', [{ tag: '8', args: null, form: 'none' }, { tag: 'n', args: null, form: 'none' }]],
  ['¥__q', [{ tag: '__q', args: null, form: 'none' }]],
  ['¥n[half]x', [{ tag: 'n', args: ['half'], form: 'bracket' }, 'x']],
  ['¥e[', [{ tag: 'e', args: null, form: 'none' }, '[']],
  ['¥0[1]', [{ tag: '0', args: null, form: 'none' }, '[1]']],
  ['100%', ['100%']],
  // %-variables were expanded before the script reached the tokenizer (expand.js): only %* is a token
  ['%ms', ['%ms']],
  ['abc¥', [S('abc¥')]],
  ['a¥¥b¥%c', [S('a¥b%c')]],
  ['%selfname2 %selfname', ['%selfname2 %selfname']],
  ['%property[baseware.version]', ['%property[baseware.version]']],
  ['%*x', [{ env: '*' }, 'x']],
  ['%%*¥%*', ['%', { env: '*' }, '%*']],
  ['(42%)', ['(42%)']],
  ['a¥あb', ['aあb']],
  ['¥p[99]¥s[9702]', [{ tag: 'p', args: ['99'], form: 'bracket' }, { tag: 's', args: ['9702'], form: 'bracket' }]],
  ['¥_w[30]¥__w[clear]', [{ tag: '_w', args: ['30'], form: 'bracket' }, { tag: '__w', args: ['clear'], form: 'bracket' }]],
  ['¥_q¥_n¥*¥t¥C', [{ tag: '_q', args: null, form: 'none' }, { tag: '_n', args: null, form: 'none' },
    { tag: '*', args: null, form: 'none' }, { tag: 't', args: null, form: 'none' }, { tag: 'C', args: null, form: 'none' }]],
  ['¥q[Keep Reading,\x01Keep Reading\x011]', [{ tag: 'q', args: ['Keep Reading', '\x01Keep Reading\x011'], form: 'bracket' }]],
  ['¥q[ID][title]', [{ tag: 'q', args: ['ID', 'title'], form: 'bracket2' }]],
  ['¥q0[ID][title]x', [{ tag: 'q', args: ['ID', 'title'], form: 'bracket2' }, 'x']],
  ['¥y[1]z', [{ tag: 'y', args: null, form: 'none' }, '[1]z']],
  ['¥?', ['?']],
  ['¥_?¥s[1]¥n¥_?x', [{ tag: '_?', args: null, form: 'none' }, S('¥s[1]¥n'), { tag: '_?', args: null, form: 'none' }, 'x']],
  ['¥URL[cancel][http://a][A]', [{ tag: 'U', args: null, form: 'none' }, 'RL[cancel][http://a][A]']],
  ['¥_l[@-2,@3]', [{ tag: '_l', args: ['@-2', '@3'], form: 'bracket' }]],
  ['¥f[color,245,245,245]', [{ tag: 'f', args: ['color', '245', '245', '245'], form: 'bracket' }]],
  ['¥![bind,足,,0]', [{ tag: '!', args: ['bind', '足', '', '0'], form: 'bracket' }]],
  ['¥_b["a""b.png",inline]', [{ tag: '_b', args: ['a"b.png', 'inline'], form: 'bracket' }]],
  ['¥![x,"ab"cd]', [{ tag: '!', args: ['x', 'abcd'], form: 'bracket' }]],
  ['¥q[ a , b ]', [{ tag: 'q', args: [' a ', ' b '], form: 'bracket' }]],
  ['¥![raise,OnX,a¥¥]b]', [{ tag: '!', args: ['raise', 'OnX', S('a¥¥')], form: 'bracket' }, 'b]']],
  ['¥_+¥+¥-', [{ tag: '_+', args: null, form: 'none' }, { tag: '+', args: null, form: 'none' }, { tag: '-', args: null, form: 'none' }]],
  ['¥i[5,wait]¥i3', [{ tag: 'i', args: ['5', 'wait'], form: 'bracket' }, { tag: 'i', args: ['3'], form: 'digit' }]],
  ['¥x[noclear]¥x', [{ tag: 'x', args: ['noclear'], form: 'bracket' }, { tag: 'x', args: null, form: 'none' }]],
  ['', []],
];

test('SS §3.9 vectors', () => {
  for (const [src0, want] of vectors) {
    const src = S(src0);
    const toks = tokenize(src);
    assert.deepEqual(view(toks), want, src0);
    covers(src, toks);
  }
});

test('unterminated bracket takes the rest of the script', () => {
  const src = S('ab¥![raise,OnX,cd');
  const toks = tokenize(src);
  assert.equal(toks.length, 2);
  assert.equal(toks[1].unterminated, true);
  assert.deepEqual(toks[1].args, ['raise', 'OnX', 'cd']);
  covers(src, toks);
});

// ssp.exe 2.9.08f's bracket grammar (SS §3.4) [disasm SPGhost::ParseParameters 0x6240d0, ParseBracket 0x624660, the
// \p / \w / \q handlers of DecodeProcReal]; the expected values are what SSP's loop builds (" " placeholder aside)
const sspVectors = [
  // a quote opens anywhere outside quotes and is dropped; the argument goes on after it closes
  ['¥![raise,OnX,a"b,c]d"e]x', [{ tag: '!', args: ['raise', 'OnX', 'ab,c]de'], form: 'bracket' }, 'x']],
  ['¥![raise,OnX,a""b]', [{ tag: '!', args: ['raise', 'OnX', 'ab'], form: 'bracket' }]],
  ['¥![raise,OnX, "a,b"]', [{ tag: '!', args: ['raise', 'OnX', ' a,b'], form: 'bracket' }]],
  ['¥![raise,OnX,"a"b"c,d"]', [{ tag: '!', args: ['raise', 'OnX', 'abc,d'], form: 'bracket' }]],
  ['¥![set,trayballoon,--title="a,b",--text="c]d"]', [{ tag: '!', args: ['set', 'trayballoon', '--title=a,b', '--text=c]d'], form: 'bracket' }]],
  // backslash: outside quotes every \X is a pair; \] and \, unescape; inside quotes it is data
  ['¥![raise,OnX,a¥,b]', [{ tag: '!', args: ['raise', 'OnX', 'a,b'], form: 'bracket' }]],
  ['¥![raise,OnX,a¥]b]', [{ tag: '!', args: ['raise', 'OnX', 'a]b'], form: 'bracket' }]],
  ['¥![raise,OnX,"a¥]b"]', [{ tag: '!', args: ['raise', 'OnX', S('a¥]b')], form: 'bracket' }]],
  ['¥![raise,OnX,a¥"b,c]', [{ tag: '!', args: ['raise', 'OnX', S('a¥"b'), 'c'], form: 'bracket' }]],
  ['¥![raiseother,G,OnX,¥![reload¥,shell¥]]', [{ tag: '!', args: ['raiseother', 'G', 'OnX', S('¥![reload,shell]')], form: 'bracket' }]],
  ['¥![raise,OnX,,b,]', [{ tag: '!', args: ['raise', 'OnX', '', 'b', ''], form: 'bracket' }]],
  // the script ends inside an open quote on a ']': closed there (SSP's last-character check 0x6243cf)
  ['¥![raise,OnX,"abc]', [{ tag: '!', args: ['raise', 'OnX', 'abc]'], form: 'bracket' }]],
  ['¥![raise,OnX,"a¥"b"]', [{ tag: '!', args: ['raise', 'OnX', S('a¥b]')], form: 'bracket' }]],
  // one-string tags (ParseBracket): commas are data, \, stays \,; quotes and \] as above
  ['¥n[half,x]', [{ tag: 'n', args: ['half,x'], form: 'bracket' }]],
  ['¥s[0,wait]', [{ tag: 's', args: ['0,wait'], form: 'bracket' }]],
  ['¥j[a¥,b]', [{ tag: 'j', args: [S('a¥,b')], form: 'bracket' }]],
  ['¥8[a"b,c]"d]', [{ tag: '8', args: ['ab,c]d'], form: 'bracket' }]],
  ['¥_w["1,0"]', [{ tag: '_w', args: ['1,0'], form: 'bracket' }]],
  ['¥_v["a]b.wav"]x', [{ tag: '_v', args: ['a]b.wav'], form: 'bracket' }, 'x']],
  ['%property["a]b"]', ['%property["a]b"]']],
  // \p[ reads up to the first ']', no quotes or escapes; \w[ takes digits (commas skipped), else '[' is text
  ['¥p["1]"]', [{ tag: 'p', args: ['"1'], form: 'bracket' }, '"]']],
  ['¥p[]', [{ tag: 'p', args: [''], form: 'bracket' }]],
  ['¥w[1,000]x', [{ tag: 'w', args: ['1000'], form: 'bracket' }, 'x']],
  ['¥w[ 100]x', [{ tag: 'w', args: null, form: 'none' }, '[ 100]x']],
  ['¥w["100"]', [{ tag: 'w', args: null, form: 'none' }, '["100"]']],
  ['¥w[12', [{ tag: 'w', args: null, form: 'none' }, '[12']],
  // \q: legacy whenever '[' follows (both brackets one string each); one argument = too few, the bracket is text;
  // any one character but '[' after \q is skipped
  ['¥q[A,B][C]', [{ tag: 'q', args: ['A,B', 'C'], form: 'bracket2' }]],
  ['¥q[a"]"b][t]', [{ tag: 'q', args: ['a]b', 't'], form: 'bracket2' }]],
  ['¥q[abc]x', [{ tag: 'q', args: null, form: 'none' }, '[abc]x']],
  ['¥qx[t,i]', [{ tag: 'q', args: ['t', 'i'], form: 'bracket' }]],
  ['¥qab', [{ tag: 'q', args: null, form: 'none' }, 'b']],
  ['¥q[t,"a,b",r]', [{ tag: 'q', args: ['t', 'a,b', 'r'], form: 'bracket' }]],
  // a \q[ inside a quote-free too-few bracket ends at the same ']' with no comma: too few too, known without the
  // rescan, also where the outer bracket read its '[' inside a \X pair (\q\[, \q\\q[); one after it is read anew; a
  // bracket with a '"' is rescanned (its inner \q[b,c"] is a choice)
  ['¥q[¥q[a]¥q[b,c]', [{ tag: 'q', args: null, form: 'none' }, '[', { tag: 'q', args: null, form: 'none' }, '[a]',
    { tag: 'q', args: ['b', 'c'], form: 'bracket' }]],
  ['¥q[x¥q¥[a]', [{ tag: 'q', args: null, form: 'none' }, '[x', { tag: 'q', args: null, form: 'none' }, '[a]']],
  ['¥q[x¥q¥¥q[a]', [{ tag: 'q', args: null, form: 'none' }, '[x', { tag: 'q', args: null, form: 'none' },
    { tag: 'q', args: null, form: 'none' }, '[a]']],
  ['¥q[a"¥q[b,c"]', [{ tag: 'q', args: null, form: 'none' }, '[a"', { tag: 'q', args: ['b', 'c]'], form: 'bracket' }]],
];

test('SSP\'s bracket grammar: quotes anywhere, \\X pairs, one-string tags, \\p[ \\w[ \\q (SS §3.4) [disasm]', () => {
  for (const [src0, want] of sspVectors) {
    const src = S(src0);
    const toks = tokenize(src);
    assert.deepEqual(view(toks), want, src0);
    covers(src, toks);
    assert.ok(!toks.some(t => t.unterminated), `${src0}: closed`);
  }
  // parseBracket / parseString on their own
  assert.deepEqual(parseBracket('[a,"b]c",d]', 0), { args: ['a', 'b]c', 'd'], end: 11 });
  assert.deepEqual(parseString('[a,"b]c",d]', 0), { args: ['a,b]c,d'], end: 11 });
});

// a tag that needs '[' (or a digit) but has none, with script after its name: ssp.exe 2.9.10 logs "missing '['"
// (or "… or digit") and steps back to the character after the `\`, so only the backslash is gone; \p \w \q \f \8 \m
// consume their name instead; at the end of the script nothing shows (SS §3.3) [disasm DecodeProcReal 0x628de0]
const T = (name, args = null, form = 'none') => ({ tag: name, args, form });
const bareVectors = [
  ['a¥sx', ['asx']],
  ['¥0¥s¥s[6]', [T('0'), 's', T('s', ['6'], 'bracket')]],
  ['¥1¥sもう少し', [T('1'), 'sもう少し']],
  ['¥b¥0x', ['b', T('0'), 'x']],
  ['¥i、¥j、', ['i、j、']],
  ['¥0¥!raiseother[a,b]', [T('0'), '!raiseother[a,b]']],
  ['x¥&y', ['x&y']],
  ['¥_ux¥_mx¥_w、¥_bx¥_lx¥_vx', ['_ux_mx_w、_bx_lx_vx']],
  ['¥__wx', ['__wx']],
  ['¥&¥&[amp]', ['&', T('&', ['amp'], 'bracket')]],
  // the name consumed
  ['¥px¥wx¥fx¥8x¥mx', [T('p'), 'x', T('w'), 'x', T('f'), 'x', T('8'), 'x', T('m'), 'x']],
  ['¥8¥n', [T('8'), T('n')]],
  // an optional bracket: the tag runs without
  ['¥nx¥cx¥xx¥_ax¥_sx¥__qx¥__vx', [T('n'), 'x', T('c'), 'x', T('x'), 'x', T('_a'), 'x', T('_s'), 'x', T('__q'), 'x', T('__v'), 'x']],
  // at the end of the script: nothing shows
  ['a¥s', ['a', T('s')]],
  ['¥&', [T('&')]],
  ['x¥_u', ['x', T('_u')]],
  ['¥__w', [T('__w')]],
  // \\ is still a pair
  ['¥¥sx', [S('¥sx')]],
];

test('a tag with no bracket (or digit) where it needs one: the name shows as text or is consumed, as ssp.exe (SS §3.3) [disasm]', () => {
  for (const [src0, want] of bareVectors) {
    const src = S(src0);
    const toks = tokenize(src);
    assert.deepEqual(view(toks), want, src0);
    covers(src, toks);
  }
});

// names ssp.exe 2.9.10 does not know (SS §3.2) [disasm DecodeProcReal 0x62be00, 0x62bd8c, 0x62bd71]: after `\` the
// character is read again as text (only the backslash is gone); an unknown `\_X` shows as written; an unknown `\__X`
// is swallowed; a bracket after any of them is text. \w skips one '_' when two more characters follow (0x62a191)
const U = name => ({ unknown: name, args: null, form: 'none' });
const unknownVectors = [
  ['¥k[1]x', ['k[1]x']],
  ['、¥わたくし', ['、わたくし']],
  ['¥ ¥[3]¥,¥9¥?', [' [3],9?']],
  ['¥0¥s¥[3]お別れ', [T('0'), 's[3]お別れ']],
  ['a¥_hb¥_d[stop]', [S('a¥_hb¥_d[stop]')]],
  ['¥_¥n', [S('¥_'), T('n')]],
  ['x¥_', [S('x¥_')]],
  ['¥__z[1]', [U('__z'), '[1]']],
  ['x¥__', ['x', U('__')]],
  ['¥URL[a][b]', [T('U'), 'RL[a][b]']],
  ['¥B¥U¥l¥y¥_i¥_e', [T('B'), T('U'), T('l'), T('y'), T('_i'), T('_e')]],
  ['¥_c[OnX,y]¥_cx', [T('_c', ['OnX,y'], 'bracket'), '_cx']],
  ['¥w_5x¥w_[100]¥w_x', [T('w', ['5'], 'digit'), 'x', T('w', ['100'], 'bracket'), T('w'), '_x']],
  ['¥w_5', [T('w'), '_5']],
];

test('a name ssp.exe does not know: the character is text, \\_X as written, \\__X swallowed (SS §3.2) [disasm]', () => {
  for (const [src0, want] of unknownVectors) {
    const src = S(src0);
    const toks = tokenize(src);
    assert.deepEqual(view(toks), want, src0);
    covers(src, toks);
  }
});

test('an unclosed bracket (no ] outside quotes) runs to the end of the script and is marked; SSP drops it', () => {
  for (const src0 of ['ab¥![raise,OnX,"abc] tail', '¥_a[x"]y', '¥s["5]x', '¥q[a,b][c', '¥![x¥]', '¥![x¥']) {
    const src = S(src0);
    const toks = tokenize(src);
    const t = toks[toks.length - 1];
    assert.equal(t.unterminated, true, src0);
    assert.equal(t.end, src.length, src0);
    covers(src, toks);
  }
  // \p[ has no such rule: its loop just stops at the end of the script
  assert.equal(tokenize(S('¥p[1')).some(t => t.unterminated), false);
});

// roommate (site/ghost/roommate/ghost/master/dic_Menu.txt:853) and yomi_to_syu (dic_Menu.txt:846,
// syu_s/dic_Menu.txt:393) send their web clap with the user's text in quotes after `message_body=`, behind a
// literal `[sender]`; the tag must end at its last ']' (EV §4.15)
const CLAP = '¥![execute,http-post,http://clap.webclap.com/clap.php?id=raqia_09,--param=message_body="[（拍手送信元）]（拍手送信内容）",--async=webclap]';
const clap = (sender, text) => S(CLAP).replace('（拍手送信元）', sender).replace('（拍手送信内容）', text) + S('¥e');

test('roommate\'s and yomi_to_syu\'s web clap: one tag, five arguments, the quotes dropped (EV §4.15)', () => {
  const head = ['execute', 'http-post', 'http://clap.webclap.com/clap.php?id=raqia_09'];
  const cases = [
    ['琥珀 あかね', 'こんにちは', '--param=message_body=[琥珀 あかね]こんにちは'],
    ['ヨミと柊子', 'こんにちは', '--param=message_body=[ヨミと柊子]こんにちは'],
    ['琥珀 あかね', 'バグ報告: 選択肢が, 二つ出る]', '--param=message_body=[琥珀 あかね]バグ報告: 選択肢が, 二つ出る]'],
    ['琥珀 あかね', 'say "hi"', '--param=message_body=[琥珀 あかね]say hi'],
  ];
  for (const [sender, text, param] of cases) {
    const src = clap(sender, text);
    const toks = tokenize(src);
    assert.deepEqual(view(toks), [{ tag: '!', args: [...head, param, '--async=webclap'], form: 'bracket' }, { tag: 'e', args: null, form: 'none' }], text);
    covers(src, toks);
  }
  // the template as the dictionary holds it (Satori's expansions unexpanded) is one tag too
  const raw = S(CLAP);
  assert.deepEqual(tokenize(raw).map(t => [t.type, t.end]), [['tag', raw.length]]);
  // one '"' in the user's text reopens the quote: no ']' outside quotes before the end, so SSP drops the tag and \e
  const odd = tokenize(clap('琥珀 あかね', 'one " quote'));
  assert.equal(odd.length, 1);
  assert.equal(odd[0].unterminated, true);
});

test('text tokens carry positions (OnBalloonBreak R2)', () => {
  const src = S('¥0hello¥w4world¥e');
  const toks = tokenize(src);
  assert.deepEqual(toks.map(t => t.pos), [0, 2, 7, 10, 15]);
  assert.equal(toks[3].text, 'world');
});

test('parseBracket quote rules', () => {
  assert.deepEqual(parseBracket('["a,b",c]', 0), { args: ['a,b', 'c'], end: 9 });
  assert.deepEqual(parseBracket('["a]b"]', 0).args, ['a]b']);
  assert.deepEqual(parseBracket('[,]', 0).args, ['', '']);
  assert.deepEqual(parseBracket('[]', 0).args, ['']);
});

test('huge script tokenizes in linear time', () => {
  const frame = S('¥c¥_q') + S('¥_b["unyu¥unyu0.png",inline]').repeat(64) + S('¥n¥_w[80]');
  const src = frame.repeat(400);
  const t0 = performance.now();
  const toks = tokenize(src);
  const ms = performance.now() - t0;
  assert.ok(toks.length > 400 * 64);
  assert.ok(ms < 500, `took ${ms} ms`);
  // SSP's \q "too few" rewind: 20 000 nested \q[ before one ']' each read that far (about 2 s before the region
  // shortcut, 60 KB, quadratic); with a '"' in the bracket it still rescans
  const nested = S('¥q[').repeat(20000) + ']';
  const t1 = performance.now();
  const qt = tokenize(nested);
  const ms1 = performance.now() - t1;
  assert.equal(qt.length, 40000);
  assert.ok(qt.every((t, k) => (k % 2 ? t.type === 'text' : t.name === 'q' && t.args === null)));
  assert.ok(ms1 < 500, `nested \\q[ took ${ms1} ms`);
});
