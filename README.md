# muse-stage（試作）

ビジコンの発表で、Mac版ミューズアプリ（Muse.app）の横に並べて起動する、出力専用の相方アプリです。
VRM のミューズを大きく表示し、ミューズの返事のテキストを読み上げながら口を動かします。

- 指示書: neta-cho `tasks/claude-code/2026-11-10-muse-stage-tauri-prototype.md`
- GitHub: oosawak/muse-stage-prototype（実行用の置き場所は Mac の ~/Workspace の下）

## 起動

ビルド済みのアプリ:

```
open "src-tauri/target/release/bundle/macos/Muse Stage.app"
```

作り直すとき（Node と Rust が要る）:

```
npm install
npx tauri build --bundles app   # アプリを作る
npx tauri dev                   # 開発用に起動（画面の変更がすぐ反映される）
```

## 使い方

1. Muse.app で会話する（音声入力ボタンで話す）
2. ミューズの返事をコピーして、muse-stage の右下の欄に貼る
3. 「読み上げ」（またはスペースキー、欄の中なら ⌘Enter）で、ミューズが読み上げて口が動く。字幕も出る
4. 舞台では両方のアプリを最大化（全画面）にして、3 本指スワイプで行き来する
   - 全画面：「全画面」ボタンか F キー。止める：Esc
   - 右下の操作パネルは、ふだんは薄く、マウスを動かすと濃くなる

### 読み上げのしくみ（右下の選択）

- 自動（初期）：アプリ内の WebView の speechSynthesis を使い、1.5 秒たっても始まらなければ macOS の `say` に切り替える
- WebView の speechSynthesis だけ／macOS の say だけ、にも切り替えられる。say の声は Kyoko が初期

### Muse.app から自動で取り込む（実験・第2段）

「Muse から取り込む」で、Muse.app の画面の文字をアクセシビリティ経由で読み、いちばん新しい返事を欄に入れます。
「新しい返事を自動で読む」を付けると、2 秒ごとに見て、新しい返事が出たら読み上げます。

使うには、システム設定 → プライバシーとセキュリティ → アクセシビリティ で「Muse Stage」を許可してください（未許可のままでは読めません）。エラー文で osascript が名指しされる場合は、`/usr/bin/osascript` も同じ一覧に追加して許可してください。

読み取り方式についての実機知見（2026-11-14）: Muse.app では `entire contents` が常に 0 件を返すため、子要素（UI elements）をレベルごとにたどる幅優先で AXStaticText を集めています。会話メッセージは「ユーザーメッセージ: 」「アシスタントメッセージ: 」の接頭辞つきで取れ、最新の返事は接頭辞で選びます。幅優先の走査には時間がかかるため、取り込みには十数秒かかることがあります。

## 自己確認モード

```
MUSE_SELFTEST=1 "src-tauri/target/release/bundle/macos/Muse Stage.app/Contents/MacOS/muse-stage"
```

起動すると既定の文を自動・WebView・say の順に読み上げ、全画面の切り替えと Muse.app の取り込みも試して、結果をターミナルに出します。

## 使っているもの

| もの | 作者 | ライセンス |
| --- | --- | --- |
| サンプル VRM「VRM1_Constraint_Twist_Sample」（`public/models/`、md-forge と同じもの） | (c) 2022 pixiv Inc. | VRM Public License 1.0（`public/models/README.md`） |
| three.js 0.160.0 | three.js authors | MIT |
| @pixiv/three-vrm 2.1.0 | pixiv Inc. | MIT |
| Tauri 2 | Tauri Programme | MIT / Apache-2.0 |

VRM ファイルを画面にドラッグ＆ドロップすると、そのモデルに入れ替わります（保存はしません）。
