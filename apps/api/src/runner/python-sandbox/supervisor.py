"""Trusted container entrypoint. No host paths, environment, or shell commands accepted."""
import json
import os
import pathlib
import resource
import signal
import stat
import subprocess
import sys

MAX_JOB = 1024 * 1024
MAX_XML = 2 * 1024 * 1024


def emit(value):
    print(json.dumps(value), flush=True)


def isolation():
    status = dict(line.split(':', 1) for line in pathlib.Path('/proc/self/status').read_text().splitlines())
    limits = {name: pathlib.Path('/sys/fs/cgroup', name).read_text().strip()
              for name in ('memory.max', 'memory.swap.max', 'pids.max', 'cpu.max')}
    mounts = [line.split() for line in pathlib.Path('/proc/mounts').read_text().splitlines()]
    root = next(row for row in mounts if row[1] == '/')
    scratch = next(row for row in mounts if row[1] == '/work')
    assert os.getuid() == 65532 and os.getgid() == 65532
    assert int(status['CapEff'].strip(), 16) == 0
    assert status['NoNewPrivs'].strip() == '1' and status['Seccomp'].strip() == '2'
    assert limits == {'memory.max': '268435456', 'memory.swap.max': '0', 'pids.max': '32', 'cpu.max': '50000 100000'}
    assert set(os.listdir('/sys/class/net')) == {'lo'}
    assert 'ro' in root[3].split(',')
    assert scratch[2] == 'tmpfs' and {'nosuid', 'nodev', 'noexec', 'size=65536k'}.issubset(scratch[3].split(','))
    assert resource.getrlimit(resource.RLIMIT_FSIZE)[1] == 4194304
    assert resource.getrlimit(resource.RLIMIT_NOFILE)[1] == 128
    assert resource.getrlimit(resource.RLIMIT_CORE)[1] == 0
    return {'protocol': 1, 'isolated': True, 'limits': limits}


def report_xml():
    try:
        descriptor = os.open('/work/result.xml', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_XML:
            raise ValueError('unsafe report')
        data = stream.read(MAX_XML + 1)
        if len(data) > MAX_XML:
            raise ValueError('oversized report')
        return data.decode('utf-8', errors='strict')


def main():
    emit({'kind': 'ready', **isolation()})
    # Bound idle lifetime even if the API disappears before submitting input.
    signal.alarm(10)
    raw = sys.stdin.buffer.readline(MAX_JOB + 1)
    signal.alarm(0)
    if len(raw) > MAX_JOB:
        raise ValueError('oversized job')
    job = json.loads(raw)
    if job.get('probe') is True:
        emit({'kind': 'verified'})
        return
    timeout = job['timeoutMs']
    if type(timeout) is not int or not 100 <= timeout <= 30000:
        raise ValueError('invalid deadline')
    files = job['files']
    if not isinstance(files, dict) or not 1 <= len(files) <= 100:
        raise ValueError('invalid files')
    project = pathlib.Path('/work/project')
    project.mkdir()
    for name, content in files.items():
        parts = name.split('/')
        if (not isinstance(content, str) or len(name) > 200 or '\\' in name
                or any(part in ('', '.', '..') for part in parts)
                or any(not (char.isascii() and (char.isalnum() or char in '_-./')) for char in name)):
            raise ValueError('invalid path')
        target = project.joinpath(*parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8')
    environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp', 'LANG': 'C.UTF-8',
                   'PYTHONDONTWRITEBYTECODE': '1', 'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1'}
    termination = None
    with open('/work/private.log', 'wb') as log:
        process = subprocess.Popen([sys.executable, '-I', '-m', 'pytest', '-c', '/opt/testmind/pytest.ini',
            '--rootdir=/work/project', '--junitxml=/work/result.xml', '-o', 'junit_family=xunit2',
            '-o', 'junit_logging=no', '-p', 'no:cacheprovider', '-q', '/work/project'],
            cwd=project, env=environment, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        try:
            process.wait(timeout=timeout / 1000)
        except subprocess.TimeoutExpired:
            termination = 'timeout'
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    try:
        xml = report_xml()
    except (OSError, ValueError):
        xml = ''  # Invalid report; no fallback to raw logs or other paths.
    emit({'kind': 'result', 'exitCode': process.returncode, 'termination': termination, 'xml': xml})
    # PID 1 exiting causes the runtime to terminate remaining container descendants.


if __name__ == '__main__':
    try:
        main()
    except Exception:
        emit({'kind': 'error', 'code': 'PYTEST_SANDBOX_FAILED'})
        sys.exit(1)
