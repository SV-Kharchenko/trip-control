// Редакція юридичних документів (дата редакції в legal/offer.html і legal/privacy.html).
// Та сама константа є в index.html (LEGAL_VERSION) і в дозволеному списку
// public.record_signup_consent() (міграція). Оновлюйте всі три разом — див. docs/LEGAL.md.

export const LEGAL_VERSION = '2026-10-20';

// Короткі адреси документів (vercel.json rewrites → legal/*.html).
export const LEGAL_URLS = Object.freeze({
    offer: '/offer',
    privacy: '/privacy',
    paymentRefund: '/payment-refund'
});

// Версії, з якими приймаємо згоду. Для нової редакції додайте дату сюди і в міграцію.
export const ACCEPTED_LEGAL_VERSIONS = Object.freeze(['2026-10-18', LEGAL_VERSION]);

export function isAcceptedLegalVersion(version) {
    return ACCEPTED_LEGAL_VERSIONS.includes(String(version || ''));
}
