# Code samples

Syntax highlighting happens in Rust with syntect. Hover a block to copy it.

## JavaScript

```javascript
// Debounce a function
export function debounce(fn, ms = 150) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
```

## TypeScript

```typescript
type Heading = { level: number; text: string; id: string };

function outline(headings: Heading[]): string[] {
  return headings.map((h) => `${"  ".repeat(h.level - 1)}- ${h.text}`);
}
```

## Python

```python
from dataclasses import dataclass

@dataclass
class Doc:
    path: str
    title: str = "Untitled"

    def slug(self) -> str:
        return self.title.lower().replace(" ", "-")

print(Doc("/tmp/a.md", "Hello World").slug())
```

## Go

```go
package main

import "fmt"

func main() {
	for i := 0; i < 3; i++ {
		fmt.Printf("hello %d\n", i)
	}
}
```

## Shell

```bash
#!/usr/bin/env bash
set -euo pipefail
for f in *.md; do
  echo "Rendering $f"
done
```

## JSON

```json
{
  "name": "md-reader",
  "version": "0.1.0",
  "private": true,
  "features": ["outline", "find", "quick-open"]
}
```

## CSS

```css
.markdown-body pre {
  padding: 16px;
  overflow: auto;
  border-radius: 8px;
}
```

## SQL

```sql
SELECT title, COUNT(*) AS views
FROM documents
WHERE updated_at > NOW() - INTERVAL '7 days'
GROUP BY title
ORDER BY views DESC
LIMIT 10;
```

## Diff

```diff
- let theme = "light";
+ let theme = prefersDark ? "dark" : "light";
```

## Unknown language

```brainfudge
++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.
```

## A very long line

```text
This line is intentionally very long so that the code block has to scroll horizontally instead of wrapping, which keeps the code layout intact for wide content like tables or log lines.
```
