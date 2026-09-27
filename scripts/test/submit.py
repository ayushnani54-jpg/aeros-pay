#!/usr/bin/env python3
"""
Submits a Next.js Server Action form via progressive-enhancement (no JS),
mimicking exactly what a browser does when it POSTs a <form action={serverAction}>.

Cookies are handled manually (reading/writing the Netscape cookie file
format directly) rather than via http.cookiejar, which mishandles the
"localhost" domain in some Python versions.

Usage:
  python3 submit.py <page_url> <cookie_jar_path> <form_index (1-based)> key=value [key=value ...]
"""
import sys
import re
import os
import uuid
import urllib.request
import urllib.error

def read_cookies(path):
    cookies = {}
    if not os.path.exists(path):
        return cookies
    with open(path) as f:
        for line in f:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) >= 7:
                cookies[parts[5]] = parts[6]
    return cookies

def write_cookies(path, cookies):
    with open(path, "w") as f:
        f.write("# Netscape HTTP Cookie File\n")
        for name, value in cookies.items():
            f.write(f"localhost\tFALSE\t/\tFALSE\t2147483647\t{name}\t{value}\n")

def cookie_header(cookies):
    return "; ".join(f"{k}={v}" for k, v in cookies.items())

def fetch(url, cookies):
    req = urllib.request.Request(url)
    if cookies:
        req.add_header("Cookie", cookie_header(cookies))
    resp = urllib.request.urlopen(req)
    html = resp.read().decode("utf-8")
    new_cookies = parse_set_cookie(resp.headers.get_all("Set-Cookie") or [])
    return html, new_cookies

def parse_set_cookie(headers):
    out = {}
    for h in headers:
        kv = h.split(";")[0]
        if "=" in kv:
            k, v = kv.split("=", 1)
            out[k.strip()] = v.strip()
    return out

def extract_forms(html):
    return re.findall(r"<form[^>]*>(.*?)</form>", html, re.S)

def extract_hidden_inputs(form_html):
    fields = {}
    for m in re.finditer(r'<input type="hidden" name="([^"]+)"(?:\s+value="([^"]*)")?/?>', form_html):
        name = m.group(1)
        value = m.group(2) or ""
        value = value.replace("&quot;", '"').replace("&amp;", "&").replace("&#x27;", "'")
        fields[name] = value
    return fields

def main():
    url = sys.argv[1]
    cookie_path = sys.argv[2]
    form_index = int(sys.argv[3]) - 1
    overrides = dict(kv.split("=", 1) for kv in sys.argv[4:])

    cookies = read_cookies(cookie_path)
    html, new_cookies = fetch(url, cookies)
    cookies.update(new_cookies)

    forms = extract_forms(html)
    if form_index >= len(forms):
        print(f"ERROR: only {len(forms)} forms found on page, requested index {form_index+1}", file=sys.stderr)
        sys.exit(2)

    fields = extract_hidden_inputs(forms[form_index])
    fields.update(overrides)

    boundary = uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n")
    parts.append(f"--{boundary}--\r\n")
    body = "".join(parts).encode("utf-8")

    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("Cookie", cookie_header(cookies))
    req.add_header("Origin", "http://localhost:3000")

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    opener = urllib.request.build_opener(NoRedirect)

    try:
        resp = opener.open(req)
        status = resp.status
        loc = resp.headers.get("Location")
        out = resp.read().decode("utf-8", errors="replace")
        set_cookies = parse_set_cookie(resp.headers.get_all("Set-Cookie") or [])
    except urllib.error.HTTPError as e:
        status = e.code
        loc = e.headers.get("Location")
        out = e.read().decode("utf-8", errors="replace")
        set_cookies = parse_set_cookie(e.headers.get_all("Set-Cookie") or [])

    cookies.update(set_cookies)
    write_cookies(cookie_path, cookies)

    print(f"STATUS: {status}")
    print(f"LOCATION: {loc}")
    print("---BODY(full)---")
    print(out)

if __name__ == "__main__":
    main()
