function similarityDetails(firstText, secondText) {
  const shingles = (text) => {
    const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
    if (words.length < 5) return new Map();
    const found = new Map();
    for (let index = 0; index <= words.length - 5; index += 1) {
      const key = words.slice(index, index + 5).map((word) => word[0].toLocaleLowerCase()).join(' ');
      if (!found.has(key)) {
        const start = words[index].index;
        const end = words[index + 4].index + words[index + 4][0].length;
        found.set(key, text.slice(start, end));
      }
    }
    return found;
  };
  const first = shingles(firstText);
  const second = shingles(secondText);
  if (!first.size || !second.size) return { percent: 0, excerpts: [] };
  const shared = [...first.keys()].filter((key) => second.has(key));
  const denominator = Math.min(first.size, second.size);
  return {
    percent: Math.round(shared.length / denominator * 100),
    excerpts: shared.slice(0, 3).map((key) => ({
      excerpt: first.get(key).slice(0, 240),
      comparisonExcerpt: second.get(key).slice(0, 240),
    })),
  };
}

module.exports = { similarityDetails };
