#!/usr/bin/env python3
"""Reproducible on-page SEO audit for terseai.org.
Fetches every URL in the live sitemap and scores each page against concrete
on-page SEO factors (the same class of checks Lighthouse's SEO category uses,
plus structured-data and social-meta checks). Prints a per-page scorecard and a
site-wide baseline. Re-run anytime: python3 seo_audit.py
"""
import re, json, sys, urllib.request, concurrent.futures, ssl

SITEMAP = "https://www.terseai.org/sitemap.xml"
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def fetch(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 SEO-Audit"})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        return r.status, r.read().decode("utf-8", "replace")

# Each check: (name, weight, fn(html,url)->bool). Weighted to 100.
def check_title(h,u):
    m=re.search(r"<title>(.*?)</title>",h,re.S);
    return bool(m and 10<=len(re.sub(r"&[a-z]+;","x",m.group(1)).strip())<=70)
def check_meta_desc(h,u):
    m=re.search(r'<meta name="description" content="([^"]*)"',h)
    return bool(m and 50<=len(m.group(1))<=170)
def check_canonical(h,u):
    return bool(re.search(r'rel="canonical" href="https://www\.terseai\.org',h))
def check_canonical_match(h,u):
    c=re.search(r'canonical" href="([^"]+)"',h); o=re.search(r'og:url" content="([^"]+)"',h)
    return bool(c and o and c.group(1)==o.group(1))
def check_robots(h,u):
    # Indexable unless an explicit noindex is present. Absence of the tag is fine.
    m=re.search(r'name="robots" content="([^"]*)"',h)
    return not (m and "noindex" in m.group(1).lower())
def check_h1(h,u):
    return len(re.findall(r"<h1[ >]",h))>=1
def check_viewport(h,u):
    return 'name="viewport"' in h
def check_lang(h,u):
    return bool(re.search(r'<html[^>]*\blang=',h))
def check_og(h,u):
    return all(f'og:{k}' in h for k in ("title","description","url")) and "og:image" in h
def check_twitter(h,u):
    return 'name="twitter:card"' in h
def check_jsonld(h,u):
    blocks=re.findall(r'type="application/ld\+json"[^>]*>(.*?)</script>',h,re.S)
    if not blocks: return False
    for b in blocks:
        try: json.loads(b.strip())
        except: return False
    return True
def check_img_alt(h,u):
    imgs=re.findall(r"<img\b[^>]*>",h)
    if not imgs: return True
    missing=[i for i in imgs if not re.search(r'\balt=',i)]
    return len(missing)==0
def check_content(h,u):
    text=re.sub(r"<script.*?</script>|<style.*?</style>","",h,flags=re.S)
    text=re.sub(r"<[^>]+>"," ",text)
    return len(text.split())>=300
def check_internal_links(h,u):
    return len(set(re.findall(r'href="(/[a-z0-9-]+)"',h)))>=5

CHECKS=[
    ("title tag (good length)",10,check_title),
    ("meta description (good length)",10,check_meta_desc),
    ("canonical (www)",10,check_canonical),
    ("canonical==og:url",6,check_canonical_match),
    ("indexable (robots)",12,check_robots),
    ("has H1",8,check_h1),
    ("viewport meta",6,check_viewport),
    ("html lang",4,check_lang),
    ("Open Graph tags",8,check_og),
    ("Twitter card",4,check_twitter),
    ("valid JSON-LD",12,check_jsonld),
    ("all images have alt",4,check_img_alt),
    ("content >=300 words",8,check_content),
    ("internal links >=5",8,check_internal_links),
]
TOTAL_W=sum(w for _,w,_ in CHECKS)

def audit(url):
    try:
        st,h=fetch(url)
    except Exception as e:
        return url,0,["FETCH FAILED: "+str(e)[:60]],st if 'st' in dir() else 0
    if st!=200:
        return url,0,[f"HTTP {st}"],st
    got=0; fails=[]
    for name,w,fn in CHECKS:
        try: ok=fn(h,url)
        except: ok=False
        if ok: got+=w
        else: fails.append(name)
    return url,round(got/TOTAL_W*100),fails,st

def main():
    st,sm=fetch(SITEMAP)
    urls=re.findall(r"<loc>([^<]+)</loc>",sm)
    print(f"Auditing {len(urls)} pages from sitemap...\n")
    results=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        for r in ex.map(audit,urls): results.append(r)
    results.sort(key=lambda x:x[1])
    print(f"{'SCORE':>5}  {'URL':<52} ISSUES")
    print("-"*100)
    for url,score,fails,stt in results:
        path=url.replace("https://www.terseai.org","") or "/"
        issues=", ".join(fails[:4]) if fails else "clean ✓"
        print(f"{score:>4}  {path:<52} {issues}")
    avg=round(sum(r[1] for r in results)/len(results))
    perfect=sum(1 for r in results if r[1]==100)
    print("-"*100)
    print(f"\nBASELINE — site average on-page SEO score: {avg}/100")
    print(f"Pages at 100: {perfect}/{len(results)}")
    # aggregate most common issues
    from collections import Counter
    c=Counter(f for _,_,fails,_ in results for f in fails)
    if c:
        print("\nMost common issues across site:")
        for name,n in c.most_common(8):
            print(f"  {n:>3} pages — {name}")

if __name__=="__main__":
    main()
