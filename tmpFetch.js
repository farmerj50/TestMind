const https = require('https');
https.get('https://justicepathlaw.com/pricing', (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    console.log(data.slice(0, 2000));
  });
}).on('error', (err) => console.error('err', err));
