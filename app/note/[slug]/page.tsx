import type { Metadata } from "next";
import { getStudyGuide } from "@/lib/studyGuide";
import { GuideClient } from "./GuideClient";

const SITE_URL = "https://quizliai.com";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const guide = await getStudyGuide(slug);

  if (!guide) {
    return {
      title: "Study Guide | QuizliAI",
      description: "AI-generated study guide with notes, flashcards, and quiz.",
    };
  }

  const description =
    guide.tldr && guide.tldr.length > 0
      ? guide.tldr[0].slice(0, 160)
      : "AI-generated study guide with notes, flashcards, and quiz.";

  return {
    title: `${guide.title} | QuizliAI`,
    description,
    alternates: { canonical: `${SITE_URL}/note/${slug}` },
    openGraph: {
      title: guide.title,
      description,
      ...(guide.youtubeId
        ? { images: [{ url: `https://img.youtube.com/vi/${guide.youtubeId}/maxresdefault.jpg` }] }
        : {}),
    },
  };
}

export default async function PublicStudyGuidePage({ params }: PageProps) {
  const { slug } = await params;
  const guide = await getStudyGuide(slug);
  return <GuideClient slug={slug} initialGuide={guide} />;
}
