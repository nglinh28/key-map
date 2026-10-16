#!/usr/bin/env python3
"""SFTP helper: scratch_sftp.py host user pass <remote_path> [local_path]
Without local_path: listdir + stat of remote_path.
With local_path given: download remote_path (a file) to local_path.
If local_path is a directory: upload local_path recursively to remote_path (relative).
If remote_path starts with '/' and ends with '/' and no local_path: upload cwd recursively."""
import sys, os, paramiko, stat

host, user, password = sys.argv[1], sys.argv[2], sys.argv[3]
remote = sys.argv[4]
local = sys.argv[5] if len(sys.argv) > 5 else None

s = paramiko.SSHClient()
s.set_missing_host_key_policy(paramiko.AutoAddPolicy())
s.connect(host, username=user, password=password, look_for_keys=False,
          allow_agent=False, timeout=30, banner_timeout=30)
ftp = s.open_sftp()
try:
    if local is None:
        # Upload cwd recursively only for relative paths ending with /
        if remote.endswith('/') and not remote.startswith('/'):
            base = remote.rstrip('/')
            count = 0
            for root, dirs, files in os.walk('.'):
                rel = os.path.relpath(root, '.')
                dest = f'{base}/{rel}' if rel != '.' else base
                try:
                    ftp.mkdir(dest)
                except Exception:
                    pass
                for fn in sorted(files):
                    src = os.path.join(root, fn)
                    dst = f'{dest}/{fn}'
                    ftp.put(src, dst)
                    count += 1
                    if count % 50 == 0:
                        print(f'  ... {count} files uploaded')
            print(f'uploaded cwd -> {remote} ({count} files)')
            sys.exit(0)
        # List/stat for absolute or non-/-ending paths
        try:
            st = ftp.stat(remote)
            kind = 'd' if stat.S_ISDIR(st.st_mode) else ('l' if stat.S_ISLNK(st.st_mode) else '-')
            print(f'{kind} {st.st_size:>12} {remote}')
            if stat.S_ISDIR(st.st_mode):
                for entry in ftp.listdir(remote):
                    p = remote if remote.endswith('/') else f'{remote}/{entry}'
                    es = ftp.stat(p)
                    kind = 'd' if stat.S_ISDIR(es.st_mode) else ('l' if stat.S_ISLNK(es.st_mode) else '-')
                    print(f'{kind} {es.st_size:>12} {entry}')
            else:
                print('(file)')
        except Exception as e:
            sys.stderr.write(f'stat error: {e}\n'); sys.exit(2)
    else:
        if os.path.isdir(local):
            # upload local dir to remote (relative path)
            dst = f'{remote}/{os.path.basename(local)}' if not remote.endswith('/') else f'{remote}{os.path.basename(local)}'
            ftp.put(local, dst)
            print(f'uploaded {local} -> {dst} ({os.path.getsize(local)} bytes)')
        else:
            with open(local, 'wb') as f:
                ftp.getfo(remote, f)
            print(f'downloaded {remote} -> {local} ({os.path.getsize(local)} bytes)')
except Exception as e:
    sys.stderr.write('sftp error: %s\n' % e); sys.exit(2)
finally:
    ftp.close(); s.close()