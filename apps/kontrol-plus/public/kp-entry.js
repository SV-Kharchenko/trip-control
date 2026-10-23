// Контроль+: гість одразу бачить форму входу, а не лендинг trip-control.com.
// Inline-скрипт сайту на початку <body> ставить html[data-entry="landing"]; спостерігач (мікрозадача — до наступного
// скрипту й до першого кадру) міняє його на "app", тож checkUserAccess() сайту показує #auth-screen. Код сайту не змінюється.
(function () {
    'use strict';
    var root = document.documentElement;
    var observer = new MutationObserver(function () {
        if (root.getAttribute('data-entry') !== 'landing') return;
        root.setAttribute('data-entry', 'app');
        root.removeAttribute('data-screen');
        observer.disconnect();
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-entry'] });
    document.addEventListener('DOMContentLoaded', function () { observer.disconnect(); });
})();
