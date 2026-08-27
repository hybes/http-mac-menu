// Paste-a-cURL-command import. Extracts the URL and headers; the fetch engine
// is GET-only, so method/body flags are acknowledged but reported.

#[derive(Debug, Default, serde::Serialize)]
pub struct CurlParse {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub warnings: Vec<String>,
}

fn unquote(token: &str) -> String {
    let t = token.trim();
    let bytes = t.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'')
            || (bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"'))
    {
        let inner = &t[1..t.len() - 1];
        // Shell double quotes allow \-escapes; single quotes do not.
        if bytes[0] == b'"' {
            return inner.replace("\\\"", "\"").replace("\\\\", "\\");
        }
        return inner.to_string();
    }
    t.to_string()
}

/// Split a command line into tokens honouring single/double quotes.
fn tokenize(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in input.chars() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                } else {
                    cur.push(c);
                }
            }
            None => match c {
                '\'' | '"' => quote = Some(c),
                '\\' => {} // line continuations were already handled below
                c if c.is_whitespace() => {
                    if !cur.is_empty() {
                        tokens.push(std::mem::take(&mut cur));
                    }
                }
                c => cur.push(c),
            },
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    tokens
}

pub fn parse(input: &str) -> CurlParse {
    let mut out = CurlParse::default();
    // Join backslash line continuations before tokenizing.
    let joined = input.replace("\\\n", " ");
    let tokens = tokenize(&joined);

    // Skip leading shell/curl invocation words.
    let mut args: &[String] = &tokens;
    while let Some(first) = args.first() {
        let f = first.as_str();
        if f == "curl" || f.ends_with("curl") && !f.contains('/') && f != "sudo" {
            args = &args[1..];
            break;
        }
        if f == "$" {
            args = &args[1..];
            continue;
        }
        break;
    }

    let mut url_parts: Vec<String> = Vec::new();
    let mut i = 0;
    let mut saw_url = false;
    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "-H" | "--header" => {
                if let Some(h) = args.get(i + 1) {
                    let h = unquote(h);
                    if let Some((k, v)) = h.split_once(':') {
                        let key = k.trim().to_string();
                        let value = v.trim().to_string();
                        if !key.is_empty()
                            && !key.eq_ignore_ascii_case("content-length")
                            && !out
                                .headers
                                .iter()
                                .any(|(ek, _)| ek.eq_ignore_ascii_case(&key))
                        {
                            out.headers.push((key, value));
                        }
                    }
                    i += 2;
                    continue;
                }
            }
            "--url" => {
                if let Some(u) = args.get(i + 1) {
                    out.url = unquote(u);
                    saw_url = true;
                    i += 2;
                    continue;
                }
            }
            "-X" | "--request" | "--method" => {
                if let Some(m) = args.get(i + 1) {
                    let m = unquote(m).to_uppercase();
                    if m != "GET" {
                        out.warnings
                            .push(format!("Only GET requests are fetched — {m} was ignored"));
                    }
                    i += 2;
                    continue;
                }
            }
            "-d" | "--data" | "--data-raw" | "--data-ascii" | "--data-binary" | "--json" => {
                out.warnings.push(
                    "Request bodies are not supported yet — only the URL and headers were imported"
                        .into(),
                );
                i += 2;
                continue;
            }
            "-u" | "--user" => {
                out.warnings.push(
                    "Basic auth (-u) was not imported — add an Authorization header instead".into(),
                );
                i += 2;
                continue;
            }
            _ if arg.starts_with('-') => {
                i += 1; // unknown flag: skip it alone (flags with values are rare)
                continue;
            }
            _ => {
                if !saw_url {
                    url_parts.push(unquote(arg));
                    saw_url = true;
                } else if out.url.is_empty() {
                    out.url = unquote(arg);
                }
                i += 1;
            }
        }
    }

    if out.url.is_empty() && !url_parts.is_empty() {
        out.url = url_parts.remove(0);
    }
    // Strip surrounding <> that curl docs use in examples.
    if out.url.starts_with('<') && out.url.ends_with('>') {
        out.url = out.url[1..out.url.len() - 1].to_string();
    }
    // Drop surrounding quotes that survived naive pasting.
    for q in ['"', '\''] {
        if out.url.starts_with(q) && out.url.ends_with(q) && out.url.len() > 1 {
            out.url = out.url[1..out.url.len() - 1].to_string();
        }
    }
    out
}
