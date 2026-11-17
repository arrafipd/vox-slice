// Password-protects this entire site with HTTP basic auth, at Netlify's edge.
//
// Netlify's own password protection is a Pro-plan feature. This is the free
// equivalent, and it runs in Netlify's Deno runtime before anything is served.
//
// NOTHING IS INSTALLED AND NOTHING IS FETCHED. The code below is the whole
// function, pasted in: no npm package, no node_modules, no package.json entry,
// and no import from an outside registry that could disappear. This replaced a
// one-line remote import from deno.land/x; that dependency is deliberately gone.
//
// THE PASSWORD IS NOT IN THIS FILE, AND MUST NOT BE. It is read at request time
// from an environment variable you set per site in the Netlify dashboard, under
// Site configuration > Environment variables:
//
//   name:   BASIC_AUTH_CREDENTIALS
//   format: username:password
//           several are space-separated -- e.g.  robbie:pick-a-password  client:another-one
//
// Avoid spaces and colons inside a password: a space starts the next
// username:password pair, and everything after the second colon is ignored on
// both sides. Letters, digits and punctuation like -_.!@#$% are all fine.
//
// FAILS CLOSED. Until that variable exists (or if its NAME has a typo) the
// site is LOCKED for everybody and shows a plain "locked" message. It is never
// silently public. After setting the variable, redeploy, then load the site in
// a private window and check you get a login prompt.
//
// What this is and is not: a front-door lock that keeps the public and search
// engines out. The credentials travel over HTTPS, but they are compared as
// plain text against a plain-text environment variable, so treat it as "not for
// strangers" rather than as protection for anything genuinely sensitive.
//
// ---------------------------------------------------------------------------
// Everything below this line started as v1.0.0 of
// acestojanoski/netlify-basic-auth-edge-function. Changes made for Vox-Slice:
//   1. a missing BASIC_AUTH_CREDENTIALS now locks the site (it used to leave
//      it public),
//   2. the 401 names a realm and is never cached,
//   3. the `export default handler` line at the end.
//
// Reproduced under its MIT licence, which requires this notice to travel with
// the code:
//
//   MIT License
//
//   Copyright (c) Aleksandar Stojanoski
//
//   Permission is hereby granted, free of charge, to any person obtaining a
//   copy of this software and associated documentation files (the "Software"),
//   to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense,
//   and/or sell copies of the Software, and to permit persons to whom the
//   Software is furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in
//   all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
//   FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//   DEALINGS IN THE SOFTWARE.
// ---------------------------------------------------------------------------

function unauthorized() {
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'www-authenticate': 'Basic realm="Vox-Slice", charset="UTF-8"',
      'cache-control': 'no-store',
    },
  })
}

function locked() {
  return new Response('Vox-Slice is locked: no login has been set up for this site yet.', {
    status: 503,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export function handler(request: Request) {
  try {
    const credentialsConfig = Deno.env.get('BASIC_AUTH_CREDENTIALS')

    // No login configured: keep everybody out rather than serve the site publicly
    if (!credentialsConfig || !credentialsConfig.trim()) {
      return locked()
    }

    const authorization = request.headers.get('authorization')

    if (!authorization) {
      return unauthorized()
    }

    const base64Credentials = authorization.split('Basic ')[1]

    if (!base64Credentials) {
      return unauthorized()
    }

    const [username, password] = atob(base64Credentials).split(':')

    const allowedCombinations = credentialsConfig
      .split(' ')
      .filter(Boolean)
      .map((credentials) => credentials.split(':'))

    const isAuthorized = allowedCombinations.some(
      ([allowedUsername, allowedPassword]) =>
        Boolean(allowedUsername) && Boolean(allowedPassword) &&
        allowedUsername === username && allowedPassword === password,
    )

    if (!isAuthorized) {
      return unauthorized()
    }
  } catch (error) {
    console.error('[netlify-basic-auth-edge-function] error', error)

    return new Response('Bad Gateway', {
      status: 502,
    })
  }
}

export default handler
