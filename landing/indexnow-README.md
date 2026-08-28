# IndexNow

`d335b71851b4f222ee8643534f4f5cbb.txt` is the ownership proof for the IndexNow protocol: the file lives at
the site root and contains nothing but the key itself. Bing, Yandex, Seznam and
Naver consume IndexNow submissions, and Bing is what Copilot answers from.

Google retired its sitemap ping endpoint (`google.com/ping?sitemap=`) in early
2024 — it now returns 404 — so Google is reached through Search Console, which
this domain does not yet have verified.

To notify after a deploy:

    curl -X POST https://api.indexnow.org/indexnow \
      -H 'Content-Type: application/json' \
      -d '{"host":"www.terseai.org","key":"d335b71851b4f222ee8643534f4f5cbb",
           "keyLocation":"https://www.terseai.org/d335b71851b4f222ee8643534f4f5cbb.txt",
           "urlList":["https://www.terseai.org/", "..."]}'
