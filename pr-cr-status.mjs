// Replace a repository summary's selected PR with its fresh per-PR result
// before ranking it against other PRs. Pending siblings must not resurrect
// resolved findings on the previously selected PR.
export function reconcileCrSummary(summary, perPr) {
  const fresh = summary?.prNumber && perPr.find(pr => pr.prNumber === summary.prNumber);
  return fresh ? {...summary, ...fresh} : summary;
}
