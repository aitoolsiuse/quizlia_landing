"use client";

import Link from "next/link";
import { ItemActionsMenu } from "@/components/app/ItemActionsMenu";
import { Topic, getYouTubeThumbnail, getSourceIcon } from "@/lib/types";

interface TopicCardProps {
  topic: Topic;
  onDelete: (topicId: string) => void;
  onRename: (topic: Topic) => void;
  onMove: (topic: Topic) => void;
}

function formatDate(dateString: string) {
  const date = new Date(dateString);
  const now = new Date();
  const diffTime = Math.abs(now.getTime() - date.getTime());
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function TopicCard({ topic, onDelete, onRename, onMove }: TopicCardProps) {
  const thumbnail = topic.sourceType === "youtube" && topic.sourceUrl
    ? getYouTubeThumbnail(topic.sourceUrl)
    : null;

  return (
    <div className="group bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl shadow-sm hover:shadow-lg transition-all hover:border-blue-500 dark:hover:border-blue-500 relative">
      {/* Hover actions */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete(topic.id);
          }}
          className="bg-red-500 hover:bg-red-600 text-white rounded-full p-2 shadow-lg"
          title="Delete topic"
        >
          <span className="material-symbols-outlined text-sm">delete</span>
        </button>
        <ItemActionsMenu
          onRename={() => onRename(topic)}
          onMove={() => onMove(topic)}
          buttonClassName="bg-white dark:bg-gray-900 shadow-sm"
        />
      </div>

      <Link href={`/note/topic/${topic.id}`} className="block">
        {thumbnail && (
          <div className="relative h-40 bg-gray-100 dark:bg-gray-800 rounded-t-xl overflow-hidden">
            <img src={thumbnail} alt="Thumbnail" className="w-full h-full object-cover" />
            <div className="absolute inset-0 bg-black/20 group-hover:bg-black/10 transition-colors" />
          </div>
        )}

        <div className="p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="bg-purple-100 dark:bg-purple-900/30 text-purple-600 rounded-md p-1.5">
              <span className="material-symbols-outlined">{getSourceIcon(topic.sourceType)}</span>
            </div>
            <span className="text-xs text-gray-500 dark:text-gray-400 uppercase">
              {topic.sourceType}
            </span>
          </div>

          <h3 className="text-base font-semibold text-gray-900 dark:text-white line-clamp-2 mb-3">
            {topic.title}
          </h3>

          {/* Material Indicators */}
          <div className="flex flex-wrap gap-2">
            {topic.note && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                <span className="material-symbols-outlined text-xs">description</span>
                Notes
              </span>
            )}
            {topic.flashcards && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
                <span className="material-symbols-outlined text-xs">style</span>
                {topic.flashcards.length}
              </span>
            )}
            {topic.quiz && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300">
                <span className="material-symbols-outlined text-xs">quiz</span>
                {topic.quiz.length}
              </span>
            )}
          </div>
        </div>

        <div className="border-t border-gray-200 dark:border-gray-800 px-5 py-3 flex justify-between items-center">
          <span className="text-xs text-gray-600 dark:text-gray-400">{formatDate(topic.createdAt)}</span>
          <span className="text-sm font-medium text-blue-600 dark:text-blue-400 flex items-center gap-1">
            View <span className="material-symbols-outlined text-sm">arrow_forward</span>
          </span>
        </div>
      </Link>
    </div>
  );
}
