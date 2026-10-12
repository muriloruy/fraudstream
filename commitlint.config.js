export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Allow long trailers such as Co-Authored-By / session links.
    'footer-max-line-length': [0],
    'body-max-line-length': [0],
  },
};
