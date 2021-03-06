const { readFile } = require('fs');
const { promisify } = require('util');
const { compile } = require('handlebars');
const ObjectPath = require('object-path');
const { join } = require('path');
const { parse } = require('url');
const RPCClient = require('micro-rpc-client');
const { isShutingDown } = require('@bufferapp/shutdown-helper');
const bufferApi = require('./bufferApi');
const {
  writeCookie,
  createSession,
  updateSession,
  getCookie,
  destroySession,
  serviceUrl,
} = require('@bufferapp/session-manager');

const readFileAsync = promisify(readFile);

const controller = module.exports;

const parseErrorMessage = ({ err }) => {
  switch (err.statusCode) {
    case 500:
    case 400:
      return 'Oops! An unexpected error occured, please try again.';
    default:
      return err.error.error;
  }
};

const redirectWithError = ({
  baseRoute,
  redirect,
  err,
  res,
}) => {
  const queryParams = {
    redirect,
    errorMessage: parseErrorMessage({ err }),
    errorCode: err.statusCode,
  };
  return res.redirect(`${baseRoute}?${
    Object.keys(queryParams)
      .filter(key => queryParams[key])
      .map(key => `${key}=${queryParams[key]}`)
      .join('&')
  }`);
};

let cachedLoginTemplate;
const loginTemplate = async () => {
  if (cachedLoginTemplate) {
    return cachedLoginTemplate;
  }
  const template = await readFileAsync(join(__dirname, '../views/login.html'));
  cachedLoginTemplate = compile(template.toString());
  return cachedLoginTemplate;
};
// call this before any request to load it into memory
loginTemplate();

let cachedTFATemplate;
const tfaTemplate = async () => {
  if (cachedTFATemplate) {
    return cachedTFATemplate;
  }
  const template = await readFileAsync(join(__dirname, '../views/tfa.html'));
  cachedTFATemplate = compile(template.toString());
  return cachedTFATemplate;
};
// call this before any request to load it into memory
tfaTemplate();

let cachedMainTemplate;
const mainTemplate = async () => {
  if (cachedMainTemplate) {
    return cachedMainTemplate;
  }
  const template = await readFileAsync(join(__dirname, '../views/main.html'));
  cachedMainTemplate = compile(template.toString());
  return cachedMainTemplate;
};
mainTemplate();

const parseBufferWebCookie = ({ apiRes }) =>
  (apiRes.headers['set-cookie'] || []).reduce((cookieValue, currentCookie) => {
    // no cookie to look at
    if (!currentCookie) {
      return cookieValue;
    }
    // cookie is not a bufferapp_ci_session cookie
    if (!(currentCookie.includes('bufferapp_ci_session'))) {
      return cookieValue;
    }
    // if we have a duplicate cookie - choose the cookie with more information
    const cookie = decodeURIComponent(currentCookie.split('; ')[0].split('=')[1]);
    if (cookieValue && cookieValue.length > cookie.length) {
      return cookieValue;
    }
    return cookie;
  }, undefined);

const passThroughBufferWebCookie = ({
  apiRes,
  res,
  production,
}) => {
  // pass through buffer web session
  const bufferWebCookie = parseBufferWebCookie({ apiRes });
  if (bufferWebCookie) {
    writeCookie({
      name: `${production ? '' : 'local'}bufferapp_ci_session`,
      value: bufferWebCookie,
      domain: '.buffer.com',
      res,
    });
  }
};

const selectClient = ({
  app,
}) => {
  switch (app) {
    case 'publish':
      return ({
        clientId: process.env.PUBLISH_CLIENT_ID,
        clientSecret: process.env.PUBLISH_CLIENT_SECRET,
        sessionKey: 'publish',
      });
    case 'analyze':
      return ({
        clientId: process.env.ANALYZE_CLIENT_ID,
        clientSecret: process.env.ANALYZE_CLIENT_SECRET,
        sessionKey: 'analyze',
      });
    case 'account':
      return ({
        clientId: process.env.PUBLISH_CLIENT_ID,
        clientSecret: process.env.PUBLISH_CLIENT_SECRET,
        sessionKey: 'account',
      });
    default:
      return ({
        clientId: process.env.PUBLISH_CLIENT_ID,
        clientSecret: process.env.PUBLISH_CLIENT_SECRET,
        sessionKey: 'account',
      });
  }
};

const parseAppFromUrl = ({
  url,
}) => {
  if (url) {
    if (url.includes('publish')) {
      return 'publish';
    } else if (url.includes('analyze')) {
      return 'analyze';
    }
  }
  return 'account';
};

const getAnyAccessToken = ({
  session = {},
}) => Object.keys(session).reduce((accessToken, key) => {
  if ('accessToken' in session[key]) {
    return session[key].accessToken;
  }
  return accessToken;
}, undefined);

const autoLoginWithAccessToken = async ({
  accessToken,
  bufferSession,
  redirect,
  req,
  res,
  next,
}) => {
  const production = req.app.get('isProduction');
  const sessionClient = req.app.get('sessionClient');
  const url = redirect ? parse(redirect).hostname : undefined;
  const { clientId, clientSecret, sessionKey } = selectClient({
    app: parseAppFromUrl({ url }),
  });

  try {
    let apiRes;
    try {
      apiRes = await bufferApi.convertSession({
        accessToken,
        createSession: !bufferSession,
        clientId,
        clientSecret,
      });
    } catch (err) {
      return redirectWithError({
        baseRoute: '/login',
        redirect,
        err,
        res,
      });
    }

    passThroughBufferWebCookie({
      res,
      apiRes,
      production,
    });

    // update the session
    const { token } = apiRes.toJSON().body;
    const session = {
      [sessionKey]: {
        accessToken: token,
      },
    };
    await updateSession({
      session,
      req,
      sessionClient,
      production,
    });
    res.redirect(redirect || '/');
  } catch (err) {
    next(err);
  }
};

const autoLoginWithBufferSession = async ({
  redirect,
  bufferSession,
  req,
  res,
  next,
}) => {
  const production = req.app.get('isProduction');
  const sessionClient = req.app.get('sessionClient');
  const url = redirect ? parse(redirect).hostname : undefined;
  const { clientId, clientSecret, sessionKey } = selectClient({
    app: parseAppFromUrl({ url }),
  });

  try {
    let apiRes;
    try {
      apiRes = await bufferApi.convertSession({
        bufferSession,
        clientId,
        clientSecret,
      });
    } catch (err) {
      return redirectWithError({
        baseRoute: '/login',
        redirect,
        err,
        res,
      });
    }

    passThroughBufferWebCookie({
      res,
      apiRes,
      production,
    });

    // create a new session
    const { user, token } = apiRes.toJSON().body;
    const session = {
      global: {
        userId: user._id,
      },
      [sessionKey]: {
        accessToken: token,
      },
    };
    await createSession({
      session,
      production,
      res,
      sessionClient,
    });

    // redirect the user back to the right place
    res.redirect(redirect || '/');
  } catch (err) {
    next(err);
  }
};

controller.login = async (req, res, next) => {
  const production = req.app.get('isProduction');
  const {
    redirect,
    errorMessage,
    errorCode,
  } = req.query;
  const accessToken = getAnyAccessToken({ session: req.session || {} });
  const bufferSession = getCookie({
    req,
    name: `${production ? '' : 'local'}bufferapp_ci_session`,
  });
  if (accessToken && !errorMessage) {
    autoLoginWithAccessToken({
      accessToken,
      bufferSession,
      redirect,
      req,
      res,
      next,
    });
  } else if (bufferSession && !errorMessage) {
    autoLoginWithBufferSession({
      bufferSession,
      redirect,
      req,
      res,
      next,
    });
  } else {
    const tmplt = await loginTemplate();
    const renderedLoginTemplate = tmplt({
      redirect,
      errorMessage,
      inputError: errorCode === '401',
    });
    const mainTmplt = await mainTemplate();
    res.send(mainTmplt({ body: renderedLoginTemplate }));
  }
};

// if the user makes it here that means the user is signing
// in for the first time anywhere
controller.handleLogin = async (req, res, next) => {
  if (
    !ObjectPath.has(req, 'body.email') ||
    !ObjectPath.has(req, 'body.password')
  ) {
    return res.send('missing required fields');
  }

  const production = req.app.get('isProduction');
  const sessionClient = req.app.get('sessionClient');
  const { redirect } = req.body;
  const url = redirect ? parse(redirect).hostname : undefined;
  const { clientId, clientSecret, sessionKey } = selectClient({
    app: parseAppFromUrl({ url }),
  });

  try {
    let apiRes;
    try {
      apiRes = await bufferApi.signin({
        email: req.body.email,
        password: req.body.password,
        createSession: true,
        clientId,
        clientSecret,
      });
    } catch (err) {
      return redirectWithError({
        baseRoute: '/login',
        redirect,
        err,
        res,
      });
    }


    passThroughBufferWebCookie({
      res,
      apiRes,
      production,
    });

    // create new session
    const { token: accessToken, user, twostep } = apiRes.toJSON().body;
    const session = {
      global: {
        userId: user._id,
      },
    };
    if (twostep) {
      session.global.tfa = twostep;
    } else {
      session[sessionKey] = {
        accessToken,
      };
    }
    await createSession({
      session,
      production,
      res,
      sessionClient,
    });

    // redirect to the right place
    let redirectURL = '/';
    if (session.global.tfa) {
      redirectURL = req.body.redirect ?
        `/login/tfa?redirect=${req.body.redirect}` :
        '/login/tfa';
    } else if (req.body.redirect) {
      redirectURL = req.body.redirect;
    }
    res.redirect(redirectURL);
  } catch (e) {
    next(e);
  }
};

controller.tfa = async (req, res) => {
  const {
    redirect,
    errorMessage,
    // we'll likely get an error code here too
    // but aren't useing it yet
  } = req.query;
  if (!ObjectPath.has(req, 'session.global.tfa')) {
    res.redirect(`/login/${redirect ? `?redirect=${redirect}` : ''}`);
  } else {
    const tmplt = await tfaTemplate();
    const renderedLoginTemplate = tmplt({
      redirect,
      errorMessage,
      isSMS: req.session.global.tfa.method === 'sms',
      inputError:
        errorMessage === 'This code doesn\'t seem to match.  Try again?',
    });
    const mainTmplt = await mainTemplate();
    res.send(mainTmplt({ body: renderedLoginTemplate }));
  }
};

controller.handleTfa = async (req, res, next) => {
  const { redirect, code } = req.body;
  if (
    !ObjectPath.has(req, 'session.global.tfa') ||
    !ObjectPath.has(req, 'session.global.userId')
  ) {
    return res.redirect(`/login/${redirect ? `?redirect=${redirect}` : ''}`);
  }
  if (!code) {
    return res.send('missing required fields');
  }

  const production = req.app.get('isProduction');
  const sessionClient = req.app.get('sessionClient');

  const url = redirect ? parse(redirect).hostname : undefined;
  const { clientId, clientSecret, sessionKey } = selectClient({
    app: parseAppFromUrl({ url }),
  });

  try {
    let apiRes;
    try {
      apiRes = await bufferApi.tfa({
        userId: req.session.global.userId,
        code,
        clientId,
        clientSecret,
        createSession: true,
      });
    } catch (err) {
      return redirectWithError({
        baseRoute:
          err.statusCode === 403 &&
          err.error.error === 'Session expired, please log in again' ?
          '/login' : '/login/tfa',
        redirect,
        err,
        res,
      });
    }

    passThroughBufferWebCookie({
      res,
      apiRes,
      production,
    });

    const { token } = apiRes.toJSON().body;
    const session = {
      global: {
        userId: req.session.global.userId,
      },
      [sessionKey]: {
        accessToken: token,
      },
    };

    await updateSession({
      session,
      req,
      sessionClient,
      production,
    });
    res.redirect(redirect || '/');
  } catch (err) {
    next(err);
  }
};

controller.logout = async (req, res, next) => {
  try {
    const { redirect } = req.query;
    const production = req.app.get('isProduction');
    await destroySession({
      req,
      res,
      production,
    });
    const baseUrl = `${serviceUrl({ production })}/login/`;
    res.redirect(
      `${baseUrl}${redirect ? `?redirect=${redirect}` : ''}`,
    );
  } catch (err) {
    next(err);
  }
};

controller.healthCheck = (req, res) => {
  if (isShutingDown()) {
    return res.status(500).json({ status: 'shutting down' });
  }
  const sessionClient = new RPCClient({
    url: `http://${process.env.SESSION_SVC_HOST}`,
  });
  sessionClient.listMethods()
    .then(() => res.status(200).json({ status: 'awesome' }))
    .catch(() => res.status(500).json({ status: 'cannot connect to session service' }));
};
