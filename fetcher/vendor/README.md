# Bundled article converter

`readgzh.py` is shipped with We-Read and is invoked automatically by
`bin/archive-second-brain.mjs`. It uses only the Python 3 standard library:
there is no `pip install` step and no dependency on a local Codex skill.

For a manually verified page, it also supports:

```bash
python3 fetcher/vendor/readgzh.py --html-file article.html \
  --source-url 'https://mp.weixin.qq.com/s/...' --out-dir ./data/.incoming
```

It deliberately stops on common WeChat verification pages. It does not solve
CAPTCHA or use browser cookies.
