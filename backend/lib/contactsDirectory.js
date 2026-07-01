// backend/lib/contactsDirectory.js
// The internal team directory served by GET /contacts-directory (requireAuth —
// office and tech roles alike). This data used to be hard-coded in the public
// contacts.html; it lives behind auth now so names/emails aren't fetchable by
// anyone on the internet. Public info (911, the main office number/address)
// stays in the static HTML.
//
// To add or change a person, edit this constant and redeploy — there's no
// admin UI for it (the directory changes a few times a year at most).

const CONTACTS_DIRECTORY = [
  {
    group: 'hr',
    title: 'HR & Admin',
    people: [
      {
        name: 'Amy Kraus',
        role: 'Human Resources',
        email: 'amyk@bates-electric.com',
        initials: 'AK',
        search: 'amy kraus human resources hr',
      },
    ],
  },
  {
    group: 'tech',
    title: 'Tech Support',
    people: [
      {
        name: 'CJ Bates',
        role: 'Tech Support · App issues',
        email: 'cjbates@bates-electric.com',
        initials: 'CB',
        search: 'cj bates tech support help app',
      },
    ],
  },
  {
    group: 'leadership',
    title: 'Leadership',
    people: [
      {
        name: 'Christopher Bates',
        role: 'President & CEO',
        email: 'cbates@bates-electric.com',
        initials: 'CB',
        search: 'christopher chris bates president ceo',
      },
    ],
  },
];

module.exports = { CONTACTS_DIRECTORY };
