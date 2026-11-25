import type { Tx } from "../lib/prisma.js";
import type { Localized } from "../lib/localized.js";

type Kind = "xp" | "badge" | "order" | "certificate" | "course" | "system";

/** The notification texts of BACKEND_SPEC §6.3, in both languages. */
export const texts = {
  enrolled: (title: Localized) => ({
    title: { en: "You are enrolled!", ar: "تم تسجيلك في الدورة!" },
    body: { en: `Start learning “${title.en}”.`, ar: `ابدأ تعلّم «${title.ar}».` },
  }),
  certificate: (title: Localized) => ({
    title: { en: "Certificate ready", ar: "الشهادة جاهزة" },
    body: { en: `You completed “${title.en}”.`, ar: `أتممت دورة «${title.ar}».` },
  }),
  order: (id: string) => ({
    title: { en: "Order confirmed", ar: "تم تأكيد الطلب" },
    body: { en: `Order ${id} is complete.`, ar: `تم إكمال الطلب ${id}.` },
  }),
  badge: (name: Localized) => ({
    title: { en: "Badge unlocked", ar: "تم فتح وسام جديد" },
    body: { en: `You earned “${name.en}”.`, ar: `حصلت على «${name.ar}».` },
  }),
  levelUp: (level: number) => ({
    title: { en: `Level ${level} reached!`, ar: `وصلت إلى المستوى ${level}!` },
    body: { en: "Keep going, you are on a roll.", ar: "واصل التقدم، أنت في تقدم رائع." },
  }),
};

export const notify = (tx: Tx, userId: string, kind: Kind, t: { title: Localized; body: Localized }, at: Date) =>
  tx.notification.create({ data: { userId, kind, title: t.title, body: t.body, at } });
