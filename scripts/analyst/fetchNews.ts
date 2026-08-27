/**
 * Latest BTC headlines, free tier.
 * Tries CryptoPanic's public endpoint first (works without a token on some plans; harmless 401/403
 * just triggers the fallback). Falls back to parsing CoinDesk's public RSS feed for BTC-tagged items
 * if CryptoPanic requires a token in your account, or the request otherwise fails.
 */
import 'dotenv/config';

export type NewsHeadline = { title: string; url: string; publishedAt?: string };

const CRYPTOPANIC_URL = 'https://cryptopanic.com/api/v1/posts/?currencies=BTC&public=true';
const COINDESK_RSS_URL = 'https://www.coindesk.com/arc/outboundfeeds/rss/';

async function fetchFromCryptoPanic(limit: number): Promise<NewsHeadline[]> {
    const token = process.env.CRYPTOPANIC_AUTH_TOKEN;
    const url = token ? `${CRYPTOPANIC_URL}&auth_token=${encodeURIComponent(token)}` : CRYPTOPANIC_URL;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`CryptoPanic request failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { results?: Array<{ title: string; url: string; published_at?: string }> };
    const results = body.results || [];
    return results.slice(0, limit).map((r) => ({ title: r.title, url: r.url, publishedAt: r.published_at }));
}

function decodeXmlEntities(text: string): string {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

async function fetchFromCoindeskRss(limit: number): Promise<NewsHeadline[]> {
    const res = await fetch(COINDESK_RSS_URL);
    if (!res.ok) {
        throw new Error(`CoinDesk RSS request failed: ${res.status} ${res.statusText}`);
    }
    const xml = await res.text();
    const items = xml.split('<item>').slice(1);
    const headlines: NewsHeadline[] = [];

    for (const item of items) {
        const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s);
        const linkMatch = item.match(/<link>(.*?)<\/link>/s);
        const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/s);
        if (!titleMatch || !linkMatch) continue;

        const title = decodeXmlEntities(titleMatch[1].trim());
        if (!/bitcoin|btc/i.test(title)) continue;

        headlines.push({
            title,
            url: linkMatch[1].trim(),
            publishedAt: pubDateMatch ? pubDateMatch[1].trim() : undefined,
        });
        if (headlines.length >= limit) break;
    }

    return headlines;
}

export async function fetchNewsHeadlines(limit = 5): Promise<{ source: string; headlines: NewsHeadline[] }> {
    try {
        const headlines = await fetchFromCryptoPanic(limit);
        if (headlines.length > 0) {
            return { source: 'cryptopanic', headlines };
        }
        throw new Error('CryptoPanic returned no results');
    } catch (cryptoPanicError) {
        console.error('CryptoPanic fetch failed, falling back to CoinDesk RSS:', cryptoPanicError);
        const headlines = await fetchFromCoindeskRss(limit);
        return { source: 'coindesk_rss', headlines };
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    fetchNewsHeadlines()
        .then((result) => console.log(JSON.stringify(result, null, 2)))
        .catch((e) => {
            console.error(e);
            process.exit(1);
        });
}
