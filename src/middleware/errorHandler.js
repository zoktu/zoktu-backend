export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';
  console.error('Error:', status, message, err.stack);
  res.status(status).json({ message });
}
