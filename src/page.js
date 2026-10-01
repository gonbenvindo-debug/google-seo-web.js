'use strict';

module.exports = function snapshot({ maxText = 30000, maxElements = 250, report = false } = {}) {
    const clean = (value, limit = 5000) => String(value || '').replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit);
    const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const labelFor = (element) => clean(element.getAttribute('aria-label') ||
        (element.id && document.querySelector('label[for="' + CSS.escape(element.id) + '"]')?.innerText) ||
        element.closest('label')?.innerText ||
        element.getAttribute('placeholder') || element.innerText || element.textContent);
    const root = document.documentElement;
    let counter = Number(root.dataset.gtmElementCounter || 0);
    const elements = [...document.querySelectorAll([
        'a[href]', 'button', 'input', 'textarea', 'select', '[role="button"]', '[role="link"]',
        '[role="textbox"]', '[role="combobox"]', '[role="tab"]', '[role="menuitem"]',
        '[role="option"]', '[role="radio"]', '[role="checkbox"]',
    ].join(','))].filter(visible).slice(0, maxElements).map((element) => {
        let id = element.getAttribute('data-gtm-id');
        if (!id) {
            id = 'e' + ++counter;
            element.setAttribute('data-gtm-id', id);
        }
        const label = labelFor(element);
        return {
            id, tag: element.tagName.toLowerCase(), role: element.getAttribute('role') || undefined,
            type: element.getAttribute('type') || undefined,
            label: report ? label : label.replace(/\s+/g, ' ').slice(0, 500),
            href: element.href || undefined,
            value: 'value' in element && element.type !== 'password' ? clean(element.value) : undefined,
            selected: ['aria-selected', 'aria-checked', 'aria-pressed'].some((name) => element.getAttribute(name) === 'true') || Boolean(element.checked),
            disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
        };
    });
    root.dataset.gtmElementCounter = String(counter);
    const bodyText = clean(document.body?.innerText, maxText);
    const headings = [...document.querySelectorAll('h1, h2, h3, [role="heading"]')]
        .filter(visible).map((element) => clean(element.innerText || element.textContent)).filter(Boolean).slice(0, 100);
    const visuals = [...document.querySelectorAll('canvas, svg, [role="img"]')].filter(visible)
        .map((element) => ({ tag: element.tagName.toLowerCase(), label: clean(element.getAttribute('aria-label') || element.getAttribute('title')) }))
        .filter(({ label }) => label).slice(0, 100);
    if (!report) return { bodyText, headings, elements, visuals };

    const tableSelector = 'table, [role="table"], [role="grid"], material-table';
    let roots = [...document.querySelectorAll(tableSelector)].filter(visible)
        .filter((element) => !element.parentElement?.closest(tableSelector))
        .filter((element) => location.hostname !== 'ads.google.com' || !element.matches('[role="grid"]') || element.querySelector('[role="columnheader"]'));
    if (!roots.length && document.querySelectorAll('[role="row"]').length > 1 &&
        (location.hostname !== 'ads.google.com' || document.querySelector('[role="columnheader"]'))) roots = [document.body];
    const tables = roots.map((element) => {
        const rows = [...element.querySelectorAll(element.matches('table') ? 'tr' : '[role="row"], material-row, material-header-row')];
        const header = rows.find((row) => row.querySelector('th, [role="columnheader"], material-header-cell'));
        return {
            name: clean(element.getAttribute('aria-label') || element.querySelector('caption')?.innerText),
            headers: header ? [...header.querySelectorAll('th, [role="columnheader"], material-header-cell, :scope > [role="gridcell"]')]
                .map((cell) => clean(cell.getAttribute('aria-label') || cell.innerText)) : [],
            rows: rows.filter((row) => visible(row) && row !== header).map((row) => {
                let cells = [...row.querySelectorAll([
                    ':scope > th', ':scope > td', ':scope > [role="columnheader"]', ':scope > [role="rowheader"]',
                    ':scope > [role="gridcell"]', ':scope > [role="cell"]', ':scope > material-cell',
                ].join(','))].filter(visible);
                if (!cells.length) cells = [...row.children].filter((child) => visible(child) && clean(child.innerText));
                return cells.map((cell) => clean(cell.innerText || cell.textContent));
            }).filter((row) => row.some(Boolean)),
        };
    }).filter(({ rows }) => rows.length);
    const controls = elements.filter(({ tag, role, label }) => tag !== 'a' && role !== 'link' && label)
        .map(({ id, label, role, tag, value, selected, disabled }) => ({ id, label, role: role || tag, value, selected, disabled }));
    const metrics = controls.flatMap(({ label }) => {
        const lines = label.split('\n').map((line) => clean(line)).filter(Boolean);
        const index = lines.findIndex((line, position) => position > 0 && /^(?:[<>]?\d[\d.,]*[KMB]?%?|No data)$/i.test(line));
        return index < 1 ? [] : [{ label: lines[index - 1], value: lines[index], details: lines.slice(index + 1) }];
    }).filter(({ label }, index, values) => !values.slice(0, index).some((metric) => metric.label === label));
    const charts = [...document.querySelectorAll('canvas, svg, [role="img"]')].filter(visible).map((element) => ({
        type: element.tagName.toLowerCase(),
        description: clean(element.getAttribute('aria-label') || element.getAttribute('title')),
        labels: element.matches('svg') ? [...element.querySelectorAll('text')].map((text) => clean(text.textContent)).filter(Boolean).slice(0, 500) : [],
    })).filter(({ description, labels }) => description || labels.length);
    for (const [description] of bodyText.matchAll(/Chart,[^\n]+/gi)) {
        if (!charts.some((chart) => chart.description === description)) charts.push({ type: 'accessible-text', description, labels: [] });
    }
    const paginations = [...bodyText.matchAll(/(\d[\d,]*)\s*[-–]\s*(\d[\d,]*)\s+(?:of|de)\s+(\d[\d,]*)/gi)].map((match) => ({
        from: Number(match[1].replace(/,/g, '')),
        to: Number(match[2].replace(/,/g, '')),
        total: Number(match[3].replace(/,/g, '')),
    }));
    return {
        updated: bodyText.match(/Last update(?:d)?:\s*([^\n]+)/i)?.[1] || null,
        headings, metrics, controls, tables, charts, pagination: paginations[0] || null, paginations,
        links: [...document.querySelectorAll('a[href]')].filter(visible)
            .map((link) => ({ label: labelFor(link), url: link.href })).filter(({ label }) => label).slice(0, 500),
        rawText: bodyText,
    };
};
