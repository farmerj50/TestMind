import { Helmet } from "react-helmet-async";

const SITE_URL = "https://www.testsmindai.com";
const DEFAULT_OG_IMAGE = `${SITE_URL}/og-image.png`;

type SEOHeadProps = {
  title: string;
  description: string;
  canonicalPath?: string;
  noIndex?: boolean;
  jsonLd?: Record<string, unknown>;
};

export default function SEOHead({
  title,
  description,
  canonicalPath,
  noIndex = false,
  jsonLd,
}: SEOHeadProps) {
  const canonical = canonicalPath
    ? new URL(
        canonicalPath === "/" ? "/" : `/${canonicalPath.replace(/^\/+|\/+$/g, "")}`,
        SITE_URL,
      ).toString()
    : undefined;

  return (
    <Helmet>
      <title>{title}</title>
      <meta name="description" content={description} />
      <meta name="robots" content={noIndex ? "noindex,nofollow" : "index,follow"} />

      {canonical && <link rel="canonical" href={canonical} />}

      {!noIndex && (
        <>
          <meta property="og:title" content={title} />
          <meta property="og:description" content={description} />
          {canonical && <meta property="og:url" content={canonical} />}
          <meta property="og:type" content="website" />
          <meta property="og:site_name" content="TestMind AI" />
          <meta property="og:locale" content="en_US" />
          <meta property="og:image" content={DEFAULT_OG_IMAGE} />
          <meta property="og:image:width" content="1200" />
          <meta property="og:image:height" content="630" />
          <meta property="og:image:alt" content="TestMind AI autonomous software testing platform" />
          <meta name="twitter:card" content="summary_large_image" />
          <meta name="twitter:title" content={title} />
          <meta name="twitter:description" content={description} />
          <meta name="twitter:image" content={DEFAULT_OG_IMAGE} />
          <meta name="twitter:image:alt" content="TestMind AI autonomous software testing platform" />
        </>
      )}

      {jsonLd && (
        <script type="application/ld+json">
          {JSON.stringify(jsonLd).replace(/</g, "\\u003c")}
        </script>
      )}
    </Helmet>
  );
}
