// Word-match scoring between a known script and a transcript.
const ONES = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];

export function normWords(s) {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

// Longest-common-subsequence based match: how many script words appear, in
// order, in the transcript. Returns { match, ref, hyp, pct, missed }.
export function wordMatch(refText, hypText) {
  const a = normWords(refText);
  const b = normWords(hypText);
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const missed = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) { missed.push(a[i - 1]); i--; }
    else j--;
  }
  while (i > 0) { missed.push(a[i - 1]); i--; }
  const match = dp[n][m];
  return { match, ref: n, hyp: m, pct: n ? (100 * match) / n : 0, missed: missed.reverse() };
}

export { ONES };
