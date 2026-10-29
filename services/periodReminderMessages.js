/**
 * Period reminder push copy, per language.
 *
 * `private`  – default; reveals nothing about the user's cycle on the lock screen
 * `detailed` – used only when the user has turned "hide notification content" off
 */
const MESSAGES = {
  en: {
    private: { title: "Lunear reminder", body: "You have a reminder waiting in Lunear." },
    detailed: { title: "Period reminder", body: "Your period is expected in 2 days." },
  },
  zh: {
    private: { title: "Lunear 提醒", body: "Lunear 中有一条提醒等你查看。" },
    detailed: { title: "经期提醒", body: "预计你的经期将在 2 天后开始。" },
  },
  es: {
    private: { title: "Recordatorio de Lunear", body: "Tienes un recordatorio en Lunear." },
    detailed: { title: "Recordatorio de periodo", body: "Se espera tu periodo en 2 días." },
  },
  fr: {
    private: { title: "Rappel Lunear", body: "Vous avez un rappel dans Lunear." },
    detailed: { title: "Rappel de règles", body: "Vos règles sont prévues dans 2 jours." },
  },
  pt: {
    private: { title: "Lembrete do Lunear", body: "Você tem um lembrete no Lunear." },
    detailed: { title: "Lembrete de menstruação", body: "Sua menstruação é esperada em 2 dias." },
  },
  ja: {
    private: { title: "Lunear からのお知らせ", body: "Lunear にお知らせがあります。" },
    detailed: { title: "生理予定のお知らせ", body: "生理予定日は2日後です。" },
  },
  ar: {
    private: { title: "تذكير من Lunear", body: "لديك تذكير في Lunear." },
    detailed: { title: "تذكير بالدورة الشهرية", body: "من المتوقع أن تبدأ دورتك الشهرية بعد يومين." },
  },
  de: {
    private: { title: "Lunear-Erinnerung", body: "Du hast eine Erinnerung in Lunear." },
    detailed: { title: "Perioden-Erinnerung", body: "Deine Periode wird in 2 Tagen erwartet." },
  },
  id: {
    private: { title: "Pengingat Lunear", body: "Anda memiliki pengingat di Lunear." },
    detailed: { title: "Pengingat menstruasi", body: "Menstruasi Anda diperkirakan datang dalam 2 hari." },
  },
  ru: {
    private: { title: "Напоминание Lunear", body: "У вас есть напоминание в Lunear." },
    detailed: { title: "Напоминание о менструации", body: "Менструация ожидается через 2 дня." },
  },
  sv: {
    private: { title: "Lunear-påminnelse", body: "Du har en påminnelse i Lunear." },
    detailed: { title: "Menspåminnelse", body: "Din mens förväntas om 2 dagar." },
  },
  ur: {
    private: { title: "Lunear کی یاد دہانی", body: "Lunear میں آپ کے لیے ایک یاد دہانی ہے۔" },
    detailed: { title: "ماہواری کی یاد دہانی", body: "آپ کی ماہواری 2 دن میں متوقع ہے۔" },
  },
  hi: {
    private: { title: "Lunear रिमाइंडर", body: "Lunear में आपके लिए एक रिमाइंडर है।" },
    detailed: { title: "पीरियड रिमाइंडर", body: "आपका पीरियड 2 दिन में आने की उम्मीद है।" },
  },
};

const DEFAULT_LANGUAGE = "en";

/** Normalises "pt-BR", "PT", "zh_CN" ... to a supported 2-letter code, else "en". */
function resolveLanguage(languageCode) {
  const code = String(languageCode || "")
    .toLowerCase()
    .split(/[-_]/)[0];
  return MESSAGES[code] ? code : DEFAULT_LANGUAGE;
}

function reminderCopy(languageCode, { hideContent = true } = {}) {
  const lang = MESSAGES[resolveLanguage(languageCode)];
  return hideContent ? lang.private : lang.detailed;
}

module.exports = { MESSAGES, resolveLanguage, reminderCopy, DEFAULT_LANGUAGE };
