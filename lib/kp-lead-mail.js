// Лист про нову заявку «Замовити демо» (на support@trip-control.com).
export const LEAD_TO = 'support@trip-control.com';

const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const oneLine = (value) => String(value == null ? '' : value).replace(/[\r\n]+/g, ' ');

export function buildLeadEmail(lead) {
    const rows = [
        ['Імʼя', lead.name],
        ['Компанія', lead.company],
        ['Телефон', lead.phone],
        ['Email', lead.email || '—'],
        ['Кількість машин', lead.vehicles == null ? '—' : lead.vehicles],
        ['Коментар', lead.comment || '—']
    ];
    const subject = 'Заявка на демо Контроль+: ' + oneLine(lead.company).slice(0, 100);
    const text = ['Нова заявка на демо Контроль+', ''].concat(rows.map(([k, v]) => k + ': ' + v)).join('\n');
    const html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#0D2A28;max-width:560px"><p><b>Нова заявка на демо Контроль+</b></p>' +
        '<table style="border-collapse:collapse">' + rows.map(([k, v]) => '<tr><td style="padding:4px 14px 4px 0;color:#5A6B66;vertical-align:top">' + esc(k) +
            '</td><td style="padding:4px 0;white-space:pre-wrap">' + esc(v) + '</td></tr>').join('') + '</table></div>';
    return { subject, text, html };
}
