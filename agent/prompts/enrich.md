You are enriching one archived reading item for a private knowledge system.

Use only the supplied article body. Do not add facts that are not supported by it. If the body is navigation, boilerplate, a login/paywall notice, or otherwise lacks substantive article text, return exactly:

{"error":"insufficient_content","summary":"","tags":[],"highlights":[]}

Otherwise return only one JSON object with this shape:

{"error":"","summary":"...","tags":[{"name":"...","definition":"..."}],"highlights":["..."]}

The summary should concisely preserve the article's actual argument or useful substance. Choose a small number of specific tags. Reuse a tag from the vocabulary when it fits and use an empty definition; a genuinely new tag must include a one-line definition. Choose three to five passages a sharp reader might mark, copied exactly from the body. Do not wrap the JSON in Markdown.

Existing tag vocabulary:
{{EXISTING_TAGS}}

Title: {{TITLE}}
URL: {{URL}}

Article body:
{{BODY}}
