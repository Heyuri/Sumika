# Sumika 住処

[日本語](#ja) | [English](#en)

<a id="ja"></a>

## 日本語

Sumika（住処）は、SSP 用に作られた伺かのゴーストを、ふつうのブラウザのタブの中で動かします。ゴーストの元のファイルを、手を加えずにそのまま使います。

- 里々（Satori）、YAYA（AYA5 のゴーストも含む）、華和梨（Kawari、Phase 8 と Phase 7）のゴーストが動きます。
- ゴーストの記憶は、訪問者それぞれのブラウザに保存されます。リンクで別のページに移っても、ゴーストは挨拶し直さずに続きから現れます。
- 1つのサイトに複数のゴーストを置けます。訪問者は SSP と同じように、ゴースト・シェル・バルーンの切り替えや着せ替えができ、複数のゴーストを同時に呼び出すこともできます。
- Sumika にゴーストは付属していません。サイトに置くゴーストは、それぞれのサイトで追加します。

### はじめかた

サイトの準備は、管理プログラム `sumika-admin` を使ってブラウザの中で行えます。Python や Node は要りません。

1. Releases ページから、お使いの OS 用の `sumika-admin` と、サイトのフォルダ `sumika-site-1.0.0.zip` をダウンロードします。Windows は `sumika-admin.exe`、Mac は Apple シリコン用の `sumika-admin-macos-arm64.zip` か Intel 用の `sumika-admin-macos-x64.zip`、Linux は `sumika-admin-linux-x64.zip` です（zip は展開してから使います。Mac 版と Linux 版は、Mac や Linux での動作を確認していません）。`sumika-site-1.0.0.zip` を展開すると `sumika-site` フォルダができます。ランタイムはビルド済みで、ゴーストはまだ入っていません（このリポジトリの `site/` フォルダも同じものです）。プログラムは自分でビルドすることもできます（[docs/building.md](docs/building.md#building)）。
2. プログラムをダブルクリックすると小さなウィンドウが開き、ブラウザに管理ページが表示されます。上部の「日本語」「English」で表示する言語を切り替えられます。終了するには、その小さなウィンドウを閉じるか「終了」を押します。デジタル署名のないプログラムなので、初めて起動するときに警告が出ることがあります（[対処法](docs/guide.md#the-admin-tool)）。
3. 「サイト」画面で「サイトのフォルダを選ぶ…」を押し、中に `sumika` フォルダがあるフォルダ（`sumika-site`、このリポジトリなら `site`）を選びます。
4. 「ゴーストの追加」画面で「.nar / .zip ファイルを選ぶ…」か「フォルダを選ぶ…」を押すか、ゴーストのフォルダや .nar / .zip ファイルをページにドロップします。フォルダは、ゴーストのフォルダでも、SSP の `ghost` フォルダのようにゴーストが入ったフォルダでもかまいません。追加する前に、プログラムがそれぞれの中身を確認し、利用条件や readme を表示します。SSP の `profile/` やエンジンのセーブファイルなど、ユーザーがゴーストに教えた内容を含むファイルは、自動的に除かれます。最後に「ゴーストを1体追加」（2体なら「ゴーストを2体追加」）を押します。
5. 「確認とアップロード」画面で「サイトを確認」を押し、問題がなければ「アップロードの準備」を押します。アップロードするファイルが、アップロードする順に並びます（初回は「このサイトを以前にアップロードしたことがありますか？」と聞かれるので、「いいえ、今回が初めてのアップロードです」を選んで「続ける」を押します）。アップロードの前に、「プレビュー」画面でサイトをブラウザで試すこともできます。
6. 並んだファイル（サイトのフォルダから `dev/` を除いたもの）を、Web サーバーのルートにアップロードします。静的なファイルを公開できるサーバーなら、どこでもかまいません（サーバー側のプログラムは要りません）。ファイルを1つずつ受け取るサーバー（FTP など）では、並んだ順にアップロードしてください。
7. 下の1行を、ゴーストを表示したいページに入れます。

訪問者は、あなたのサーバーの `/sumika/` のページで、自分のブラウザで Sumika をオンにするかオフにするかを選べます。Sumika 自身はこのページにリンクしないので、あなたのページからリンクしてください。

### ページに入れる1行

```html
<script src="/sumika/sumika.js" defer></script>
```

ゴーストは画面の右下に現れます。スマートフォンに合わせて表示するには、ページに `<meta name="viewport" content="width=device-width, initial-scale=1">` も必要です。サイトをサーバーのサブフォルダに置くときは、`src` を相対パスにします。ほかのアドレスのページに入れる行は、管理プログラムの「共有」画面で作れます（[詳しく](docs/guide.md#pages-on-other-sites)）。初めての訪問者に出すゴースト、標準のバルーン、スマートフォンでの表示などのオプションは [docs/guide.md](docs/guide.md#script-options) にあります。

### 文書

詳しい説明は、以下の文書（英語）にあります。

- [docs/guide.md](docs/guide.md)：サイトでの使い方（管理プログラム、Python や Node のコマンドでのゴーストの追加と[手元での試し方](docs/guide.md#try-it-locally)、スクリプトのオプション、公開、ほかのサイトのページ、スマートフォン、ブラウザ）
- [docs/building.md](docs/building.md)：ビルドとテスト、コードの構成
- [docs/differences.md](docs/differences.md)：右クリックメニューと、SSP との違い（MIDI を含む）
- [docs/licenses.md](docs/licenses.md)：Sumika と、同梱しているもののライセンス

### ライセンス

Sumika は Heyuri Applicable Research & Development が開発し、MIT ライセンス（[LICENSE](LICENSE)）で公開しています。同梱している第三者のもの（エンジン、MIDI プレイヤーとそのサウンドフォントなど）は、それぞれのライセンスに従います（[docs/licenses.md](docs/licenses.md)）。

サイトに置くゴースト・シェル・バルーンの著作権は、それぞれの作者にあります。ゴーストをサイトで公開する前に、そのゴーストの利用条件（readme など）を読み、それに従ってください。

<a id="en"></a>

## English

Sumika (住処, "home") runs ukagaka (伺か) ghosts, the desktop mascots made for SSP, inside an ordinary browser tab,
from the ghosts' original files, unchanged.

- It runs Satori, YAYA (AYA5 ghosts too) and Kawari (Phase 8 and Phase 7) ghosts.
- A ghost's memory of each visitor is kept in that visitor's own browser. After following a link to another page,
  the ghost carries on where it was instead of greeting again.
- A site may hold several ghosts: visitors switch ghosts, shells, balloons and clothes as in SSP, and call several of
  them onto the page at once.
- No ghost comes with Sumika: each site adds the ghosts it hosts.

### Quick start

The admin program, `sumika-admin`, sets up a site in your browser. Neither Python nor Node is needed.

1. From the Releases page, download `sumika-admin` for your system and the site folder, `sumika-site-1.0.0.zip`:
   `sumika-admin.exe` for Windows, `sumika-admin-macos-arm64.zip` (Apple silicon) or `sumika-admin-macos-x64.zip`
   (Intel) for a Mac, `sumika-admin-linux-x64.zip` for Linux (unzip them first; the Mac and Linux programs are
   untested). `sumika-site-1.0.0.zip` unzips into a `sumika-site` folder: its runtime is built, and it holds no ghost
   yet (this repository's `site/` folder is the same). You can also build the programs
   ([docs/building.md](docs/building.md#building)).
2. Double-click the program. A small window opens, and your browser shows the admin page (日本語 / English at the top
   switches its language). To stop it, close that window or press **Quit**. The programs are not signed, so your
   system may warn you the first time ([what to do](docs/guide.md#the-admin-tool)).
3. On the **Site** screen, press **Choose the site folder…** and pick the folder that holds the `sumika` folder
   (`sumika-site`, or `site` in this repository).
4. On the **Add ghosts** screen, press **Choose .nar / .zip files…** or **Choose folders…** (a ghost's folder, or a
   folder of ghosts such as SSP's `ghost` folder), or drop such folders and files onto the page. Each one is looked at
   before anything is added, and its terms or readme are shown. Files that hold what a user told a ghost, such as
   SSP's `profile/` and the engines' save files, are left out automatically. Then press **Add 1 ghost**
   (**Add 2 ghosts**, …).
5. On the **Check and upload** screen, press **Check the site**, then, when it finds no problems, **Prepare upload**:
   it lists the files to upload, in order. (The first time, it asks **Has this site been uploaded before?**: choose
   **No: this is its first upload** and press **Go on**.) Before you upload, the **Preview** screen lets you try the
   site in your browser.
6. Upload those files (your site folder without `dev/`) to the root of your web host. Any host that serves static
   files will do: no server code is needed. On a host that takes files one at a time (FTP), keep the listed order.
7. Put the script line below on your pages.

Visitors turn Sumika on or off for their own browser on the page `/sumika/` of your host. Sumika never links to that
page: link it from your pages.

### The script line

```html
<script src="/sumika/sumika.js" defer></script>
```

Put it in each page that should show the ghosts; the ghost appears in the bottom-right corner. For phones, the page
also needs `<meta name="viewport" content="width=device-width, initial-scale=1">`. For a site in a subfolder of your
host, make `src` relative. Pages on your other addresses get their line from the admin program's **Sharing** screen
([more](docs/guide.md#pages-on-other-sites)). The script's options (the ghost a first-time visitor meets, the default
balloon, phones, …) are in [docs/guide.md](docs/guide.md#script-options).

### Documents

- [docs/guide.md](docs/guide.md): using Sumika on a site: the admin tool, adding ghosts with Python or Node and
  [trying the site locally](docs/guide.md#try-it-locally), script options, publishing, pages on other sites, phones
  and browsers
- [docs/building.md](docs/building.md): building, tests and the code
- [docs/differences.md](docs/differences.md): the right-click menu and the differences from SSP, MIDI included
- [docs/licenses.md](docs/licenses.md): the licences of Sumika and of the parts it includes

### License

Sumika is developed by Heyuri Applicable Research & Development and released under the MIT License
([LICENSE](LICENSE)). The third-party parts it includes, such as the engines and the MIDI player with its sound bank,
keep their own licences: see [docs/licenses.md](docs/licenses.md).

The ghosts, shells and balloons a site hosts belong to their authors. Before you publish a ghost on your site, read
its terms (its readme) and follow them.
