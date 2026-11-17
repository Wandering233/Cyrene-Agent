#!/usr/bin/env python3
"""Forward a private Wayland connection, hiding only cursor-shape globals."""
import array
import os
import selectors
import socket
import struct
import sys

listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listener.bind(sys.argv[1])
os.chmod(sys.argv[1], 0o600)
listener.listen(1)
client, _ = listener.accept()
upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
upstream.connect(sys.argv[2])
selector = selectors.DefaultSelector()
selector.register(client, selectors.EVENT_READ, upstream)
selector.register(upstream, selectors.EVENT_READ, client)
buffers = {client: bytearray(), upstream: bytearray()}
descriptors = {client: [], upstream: []}
registries = set()
try:
    while True:
        for key, _ in selector.select():
            source, destination = key.fileobj, key.data
            data, ancillary, _, _ = source.recvmsg(65536, socket.CMSG_SPACE(256 * 4))
            if not data:
                sys.exit(0)
            buffers[source].extend(data)
            for level, kind, value in ancillary:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    fds = array.array("i")
                    fds.frombytes(value[:len(value) - len(value) % fds.itemsize])
                    descriptors[source].extend(fds)
            output = bytearray()
            pending = buffers[source]
            while len(pending) >= 8:
                sender, header = struct.unpack_from("II", pending)
                size, opcode = header >> 16, header & 65535
                if size < 8 or size % 4:
                    raise ValueError("invalid Wayland message boundary")
                if len(pending) < size:
                    break
                message = bytes(pending[:size])
                del pending[:size]
                if source is client and sender == 1 and opcode == 1:
                    registries.add(struct.unpack_from("I", message, 8)[0])
                hidden = False
                if source is upstream and sender in registries and opcode == 0:
                    length = struct.unpack_from("I", message, 12)[0]
                    interface = message[16:16 + length - 1]
                    hidden = interface == b"wp_cursor_shape_manager_v1"
                if not hidden:
                    output.extend(message)
            if output:
                rights = descriptors[source]
                control = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", rights))] if rights else []
                written = destination.sendmsg([output], control)
                destination.sendall(output[written:])
                for fd in rights:
                    os.close(fd)
                rights.clear()
finally:
    for rights in descriptors.values():
        for fd in rights:
            os.close(fd)
    client.close()
    upstream.close()
    listener.close()
