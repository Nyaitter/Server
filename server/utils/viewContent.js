'use strict';

/**
 * ViewContent:
 * 元のテキストから装飾記号等を除外した表示上のプレーンテキストを抽出する。
 * 検索、トレンド抽出、おすすめ、タグ抽出に利用される。
 *
 * @param {string} content 元のポスト本文
 * @returns {string} 装飾記号を除外したテキスト
 */
function extractViewContent(content) {
  if (content == null) return '';
  let text = String(content);

  // 1. コードブロックのフェンス (```...```) を除去し、中のコード自体は残す
  text = text.replace(/```[^\r\n]*\r?\n([\s\S]*?)```/g, '$1');
  text = text.replace(/```/g, '');

  // 2. 水平線 (---, ***, ___)
  text = text.replace(/^(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '');

  // 3. 見出し記号 (# 〜 ######)
  text = text.replace(/^(?:#{1,6})\s+/gm, '');

  // 4. 引用記号 (>)
  text = text.replace(/^>\s*/gm, '');

  // 5. テーブルの区切り行 (| --- | --- |)
  text = text.replace(/^\|?(?:\s*:?-{2,}:?\s*\|?)+\s*$/gm, '');

  // 6. Markdown リンク [ラベル](URL) -> ラベル (NyarkDownタグ除去より先に行う)
  text = text.replace(/\[([^\]\r\n]+)\]\((?:https?:\/\/[^\s<>"']+|[^\s\)]+)\)/g, '$1');

  // 7. NyarkDown 装飾タグ ([c=...], [s=...], [r=...], [x=...], [y=...], [/], [/c], [b] など)
  // エスケープされていない [...] ディレクティブを除去
  text = text.replace(/\[(?:\/[a-zA-Z]{0,10}|[a-zA-Z]{1,10}(?:=[^\]\r\n]{0,64})?)\]/gi, '');
  // エスケープされた \[ や \] や \/ や \\ を解除
  text = text.replace(/\\([\[\]\/\\])/g, '$1');

  // 8. インライン装飾記号 (太字、斜体、取り消し線、下線、マーク、ネタバレ、上付き/下付き、キー、インラインコード、カスタム絵文字)
  // ***太字斜体***
  text = text.replace(/\*\*\*([^*\r\n]+)\*\*\*/g, '$1');
  // **太字**
  text = text.replace(/\*\*([^*\r\n]+)\*\*/g, '$1');
  // __太字__
  text = text.replace(/__([^_\r\n]+)__/g, '$1');
  // *斜体*
  text = text.replace(/\*([^*\r\n]+)\*/g, '$1');
  // _カスタム絵文字または斜体_
  text = text.replace(/_([^_\r\n]+)_/g, '$1');
  // ~~取り消し線~~
  text = text.replace(/~~([^~\r\n]+)~~/g, '$1');
  // ==ハイライト==
  text = text.replace(/==([^=\r\n]+)==/g, '$1');
  // ++下線++
  text = text.replace(/\+\+([^+・\r\n]+)\+\+/g, '$1');
  // ||ネタバレ||
  text = text.replace(/\|\|([^|\r\n]+)\|\|/g, '$1');
  // ^上付き^
  text = text.replace(/\^([^\^\r\n]+)\^/g, '$1');
  // ~下付き~
  text = text.replace(/~([^~\r\n]+)~/g, '$1');
  // [[キー]]
  text = text.replace(/\[\[([^\]\r\n]+)\]\]/g, '$1');
  // `インラインコード`
  text = text.replace(/`([^`\r\n]+)`/g, '$1');

  // 9. 行頭・行末のテーブル境界パイプを除去
  text = text.replace(/(?<=\n|^)\|\s*/gm, '').replace(/\s*\|(?=\n|$)/gm, '');

  return text.trim();
}

module.exports = {
  extractViewContent,
};
