import type { MetadataRoute } from "next";
import { getAllNotesForSitemap } from "@/lib/studyGuide";

const SITE_URL = "https://quizliai.com";

// ISR: regenerated at most hourly on traffic, so newly published notes
// appear without a redeploy.
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticEntries: MetadataRoute.Sitemap = [
    {
      url: SITE_URL,
      changeFrequency: "weekly",
      priority: 1,
    },
  ];

  const notes = await getAllNotesForSitemap();
  const noteEntries: MetadataRoute.Sitemap = notes.map((n) => ({
    url: `${SITE_URL}/note/${n.slug}`,
    lastModified: n.lastModified ? new Date(n.lastModified) : undefined,
    changeFrequency: "weekly",
    priority: 0.7,
  }));

  return [...staticEntries, ...noteEntries];
}
