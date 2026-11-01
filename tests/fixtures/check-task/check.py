print("проверка печатает, и это не должно мешать")

SECRET_MARKER = "секрет проверки"


def check(output, input):
    if output.strip() == "сломай проверку":
        raise ValueError(SECRET_MARKER)
    if output.strip() == "зависни":
        while True:
            pass
    try:
        divisor = int(output)
    except ValueError:
        return False
    return divisor > 1 and int(input) % divisor == 0
