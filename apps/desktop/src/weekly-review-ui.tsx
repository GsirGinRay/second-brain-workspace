import { useMemo, useState } from "react";
import { BarChart3, ChevronLeft, ChevronRight, X } from "lucide-react";
import type { BrainTaskSnapshot } from "@second-brain/brain-core";
import { formatHours } from "./today-planning";
import { completionStreak, overdueCount, weeklyReview } from "./weekly-review";

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Language = "zh-TW" | "en";

const ZH_WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const EN_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Far enough back for a quarter's review without paging forever.
const MAX_WEEKS_BACK = 12;

function shortDate(dateKey: string): string {
  return `${Number(dateKey.slice(5, 7))}/${Number(dateKey.slice(8, 10))}`;
}

export function WeeklyReviewDialog({ tasks, today, language, t, onClose }: {
  tasks: readonly BrainTaskSnapshot[];
  today: string;
  language: Language;
  t: Translate;
  onClose: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const review = useMemo(() => weeklyReview(tasks, today, offset), [tasks, today, offset]);
  const streak = useMemo(() => completionStreak(tasks, today), [tasks, today]);
  const overdue = useMemo(() => overdueCount(tasks, today), [tasks, today]);
  const peak = Math.max(1, ...review.days.map((day) => day.count));
  const projectPeak = Math.max(1, ...review.projects.map((project) => project.count), review.unassigned);
  const diff = review.done - review.previousDone;
  const weekdays = language === "zh-TW" ? ZH_WEEKDAYS : EN_WEEKDAYS;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal review-modal" role="dialog" aria-modal="true" aria-label={t("review.title")} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
        <div className="modal-header">
          <div><span className="eyebrow">WEEKLY REVIEW</span><h2>{t("review.title")}</h2></div>
          <button className="icon-button" aria-label={t("app.close")} title={t("app.close")} onClick={onClose} autoFocus><X aria-hidden="true" /></button>
        </div>
        <div className="review-week-nav">
          <button type="button" className="icon-button" disabled={offset >= MAX_WEEKS_BACK} aria-label={t("review.previousWeek")} title={t("review.previousWeek")} onClick={() => setOffset(offset + 1)}><ChevronLeft aria-hidden="true" /></button>
          <strong>{offset === 0 ? t("review.thisWeek") : offset === 1 ? t("review.lastWeek") : t("review.weeksAgo", { count: offset })}</strong>
          <span>{shortDate(review.start)} – {shortDate(review.end)}</span>
          <button type="button" className="icon-button" disabled={offset === 0} aria-label={t("review.nextWeek")} title={t("review.nextWeek")} onClick={() => setOffset(offset - 1)}><ChevronRight aria-hidden="true" /></button>
        </div>
        <div className="review-stats">
          <article>
            <strong>{review.done}</strong>
            <span>{t("review.done")}</span>
            <small className={diff > 0 ? "is-up" : diff < 0 ? "is-down" : undefined}>
              {diff === 0 ? t("review.same", { count: review.previousDone }) : t(diff > 0 ? "review.more" : "review.fewer", { count: Math.abs(diff) })}
            </small>
          </article>
          <article>
            <strong>{formatHours(review.estimatedMinutes, language)}</strong>
            <span>{t("review.time")}</span>
            {review.unestimated > 0 && <small>{t("review.unestimated", { count: review.unestimated })}</small>}
          </article>
          <article>
            <strong>{streak}</strong>
            <span>{t("review.streak")}</span>
            <small>{t("review.overdue", { count: overdue })}</small>
          </article>
        </div>
        <h3>{t("review.byDay")}</h3>
        <ol className="review-days" aria-label={t("review.byDay")}>
          {review.days.map((day, index) => (
            <li key={day.date} className={[day.future ? "is-future" : "", day.date === today ? "is-today" : ""].filter(Boolean).join(" ") || undefined} title={`${shortDate(day.date)} · ${day.count}`}>
              <span className="review-day-count">{day.future ? "" : day.count}</span>
              <span className="review-day-bar"><span style={{ height: `${day.future ? 0 : Math.round((day.count / peak) * 100)}%` }} /></span>
              <span className="review-day-label">{weekdays[index]}</span>
            </li>
          ))}
        </ol>
        <h3>{t("review.byProject")}</h3>
        {review.done === 0 ? (
          <p className="review-empty"><BarChart3 aria-hidden="true" />{t("review.empty")}</p>
        ) : (
          <ul className="review-projects">
            {[...review.projects, ...(review.unassigned ? [{ name: t("review.noProject"), count: review.unassigned }] : [])].map((project) => (
              <li key={project.name}>
                <span>{project.name}</span>
                <span className="review-project-bar"><span style={{ width: `${Math.round((project.count / projectPeak) * 100)}%` }} /></span>
                <strong>{project.count}</strong>
              </li>
            ))}
          </ul>
        )}
        <div className="modal-actions">
          <span>{t("review.hint")}</span>
          <button className="secondary-button" onClick={onClose}>{t("app.close")}</button>
        </div>
      </section>
    </div>
  );
}
