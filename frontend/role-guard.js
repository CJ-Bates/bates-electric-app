/**
 * Pre-paint role guard — loaded SYNCHRONOUSLY in the <head> of the role-routed
 * pages (home, tech, generator-care) so a user who belongs elsewhere is
 * redirected before the page shell ever paints. The cached profile
 * (localStorage 'bates.profile', written by each page's /me check) is only a
 * fast path: every page still runs its async /me check as the authority, which
 * re-caches the profile and redirects if the cached value was stale or absent.
 *
 * Routing here mirrors the pages' own async guards — keep them in sync:
 *  - /tech is the tech home; an office user is sent to /home (tech.js).
 *  - /generator-care is office-only; anyone else is sent to /home
 *    (generator-care.js).
 *  - /home redirects techs to /tech ("My Day" is their home — see commit
 *    33cfba7); office (and anyone unknown) stays (home.js).
 * A tech hitting /generator-care hops /home -> /tech; nothing loops, because
 * /home only ever redirects role 'tech' and /tech only redirects 'office'.
 *
 * With NO cached role we can't decide synchronously, so the shell is hidden
 * (html.role-pending + app.css) as a neutral loading state until the page's
 * /me check resolves and removes the class. The timeout is a failsafe: if that
 * check never resolves, fail OPEN to today's behavior rather than a blank page.
 */
(function () {
  var page = document.currentScript && document.currentScript.getAttribute('data-page');
  var role = null;
  try {
    var profile = JSON.parse(localStorage.getItem('bates.profile') || 'null');
    role = (profile && profile.role) || null;
  } catch (e) { /* corrupt cache — treat as no cached role */ }

  var dest = null;
  if (page === 'tech' && role === 'office') dest = '/home';
  else if (page === 'generator-care' && role && role !== 'office') dest = '/home';
  else if (page === 'home' && role === 'tech') dest = '/tech';

  if (dest) { window.location.replace(dest); return; }

  if (!role) {
    document.documentElement.classList.add('role-pending');
    setTimeout(function () {
      document.documentElement.classList.remove('role-pending');
    }, 4000);
  }
})();
